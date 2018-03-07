/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, commands, MessageItem, EventEmitter, Terminal } from 'vscode';
import { AzureAccount, AzureSession, CloudShell, CloudShellStatus } from './azure-account.api';
import { tokenFromRefreshToken } from './azure-account';
import { createServer, readJSON, Queue } from './ipc';
import { getUserSettings, provisionConsole, Errors, resetConsole, AccessTokens } from './cloudConsoleLauncher';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as opn from 'opn';
import * as cp from 'child_process';
import * as semver from 'semver';
import TelemetryReporter from 'vscode-extension-telemetry';

const localize = nls.loadMessageBundle();

interface OS {
	id: string;
	shellName: string;
	otherOS: OS;
}

const OSes = {
	Linux: {
		id: 'linux',
		shellName: localize('azure-account.bash', "Bash"),
		get otherOS() { return OSes.Windows; },
	},
	Windows: {
		id: 'windows',
		shellName: localize('azure-account.powershell', "PowerShell"),
		get otherOS() { return OSes.Linux; },
	}
};


function sendTelemetryEvent(reporter: TelemetryReporter, outcome: string, message?: string) {
	/* __GDPR__
	   "openCloudConsole" : {
		  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
		  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
	   }
	 */
	
	reporter.sendTelemetryEvent('openCloudConsole', message ? { outcome, message } : { outcome });
}

export function createCloudConsole(api: AzureAccount, reporter: TelemetryReporter, osName: keyof typeof OSes): CloudShell {
	const os = OSes[osName];
	let liveQueue: Queue<any> | undefined;
	const event = new EventEmitter<CloudShellStatus>();
	const state = {
		status: <CloudShellStatus>'initializing',
		onStatusChanged: event.event,
		terminal: <Terminal | undefined>undefined
	};
	(async function (): Promise<any> {

		const isWindows = process.platform === 'win32';
		if (isWindows) {
			// See below
			try {
				const { stdout } = await exec('node.exe --version');
				const version = stdout[0] === 'v' && stdout.substr(1).trim();
				if (version && semver.valid(version) && !semver.gte(version, '6.0.0')) {
					state.status = 'Failed';
					event.fire(state.status);
					return requiresNode(reporter);
				}
			} catch (err) {
				state.status = 'Failed';
				event.fire(state.status);
				return requiresNode(reporter);
			}
		}

		const loginStatus = await waitForLoginStatus(api);
		if (loginStatus === 'LoggedOut') {
			sendTelemetryEvent(reporter, 'requiresLogin');
			state.status = 'Failed';
			event.fire(state.status);
			return commands.executeCommand('azure-account.askForLogin');
		}

		// ipc
		const queue = new Queue<any>();
		const ipc = await createServer('vscode-cloud-console', async (req, res) => {
			let dequeue = false;
			for (const message of await readJSON<any>(req)) {
				if (message.type === 'poll') {
					dequeue = true;
				} else if (message.type === 'log') {
					console.log(...message.args);
				} else if (message.type === 'status') {
					state.status = message.status;
					event.fire(state.status);
				}
			}

			let response = [];
			if (dequeue) {
				try {
					response = await queue.dequeue(60000);
				} catch (err) {
					// ignore timeout
				}
			}
			res.write(JSON.stringify(response));
			res.end();
		});

		// open terminal
		let shellPath = path.join(__dirname, `../../bin/node.${isWindows ? 'bat' : 'sh'}`);
		let modulePath = path.join(__dirname, 'cloudConsoleLauncher');
		if (isWindows) {
			modulePath = modulePath.replace(/\\/g, '\\\\');
		}
		const shellArgs = [
			process.argv0,
			'-e',
			`require('${modulePath}').main()`,
		];

		if (isWindows) {
			// Work around https://github.com/electron/electron/issues/4218 https://github.com/nodejs/node/issues/11656
			shellPath = 'node.exe';
			shellArgs.shift();
		}

		const terminal = window.createTerminal({
			name: localize('azure-account.cloudConsole', "{0} in Cloud Shell", os.shellName),
			shellPath,
			shellArgs,
			env: {
				CLOUD_CONSOLE_IPC: ipc.ipcHandlePath,
			}
		});
		const subscription = window.onDidCloseTerminal(t => {
			if (t === terminal) {
				liveQueue = undefined;
				subscription.dispose();
				ipc.dispose();
				state.status = 'Disconnected';
				event.fire(state.status);
			}
		});
		liveQueue = queue;
		state.status = 'Connecting';
		state.terminal = terminal;
		event.fire(state.status);

		if (loginStatus !== 'LoggedIn') {
			queue.push({ type: 'log', args: [localize('azure-account.loggingIn', "Signing in...")] });
			if (!(await api.waitForLogin())) {
				queue.push({ type: 'log', args: [localize('azure-account.loginNeeded', "Sign in needed.")] });
				sendTelemetryEvent(reporter, 'requiresLogin');
				await commands.executeCommand('azure-account.askForLogin');
				queue.push({ type: 'exit' });
				state.status = 'Disconnected';
				event.fire(state.status);
				return;
			}
		}

		const tokens = await Promise.all(api.sessions.map(session => acquireToken(session)));
		const result = await findUserSettings(tokens);
		if (!result) {
			queue.push({ type: 'log', args: [localize('azure-account.setupNeeded', "Setup needed.")] });
			await requiresSetUp(reporter);
			queue.push({ type: 'exit' });
			state.status = 'Disconnected';
			event.fire(state.status);
			return;
		}
		
		// provision
		const session = result.token.session;
		const accessToken = result.token.accessToken;
		const armEndpoint = session.environment.resourceManagerEndpointUrl;
		const provision = async () => {
			const [graphToken, keyVaultToken] = await Promise.all([
				tokenFromRefreshToken(result.token.refreshToken, session.tenantId, session.environment.activeDirectoryGraphResourceId),
				tokenFromRefreshToken(result.token.refreshToken, session.tenantId, `https://${session.environment.keyVaultDnsSuffix.substr(1)}`)
			]);

			const consoleUri = await provisionConsole(accessToken, armEndpoint, result.userSettings, os.id);
			sendTelemetryEvent(reporter, 'provisioned');
			const accessTokens: AccessTokens = {
				resource: accessToken,
				graph: graphToken.accessToken,
				keyVault: keyVaultToken.accessToken
			};
			queue.push({
				type: 'connect',
				accessTokens,
				consoleUri
			});
		}
		try {
			queue.push({ type: 'log', args: [localize('azure-account.requestingCloudConsole', "Requesting a Cloud Shell...")] });
			await provision();
		} catch (err) {
			if (err && err.message === Errors.DeploymentOsTypeConflict) {
				const reset = await deploymentConflict(reporter, os);
				if (reset) {
					await resetConsole(accessToken, armEndpoint);
					return provision();
				} else {
					queue.push({ type: 'exit' });
					state.status = 'Disconnected';
					event.fire(state.status);
					return;
				}
			} else {
				throw err;
			}
		}
	})().catch(err => {
		console.error(err && err.stack || err);
		state.status = state.terminal ? 'Disconnected' : 'Failed';
		event.fire(state.status);
		sendTelemetryEvent(reporter, 'error', String(err && err.message || err));
		if (liveQueue) {
			liveQueue.push({ type: 'log', args: [localize('azure-account.error', "Error: {0}", String(err && err.message || err))] });
		}
	});
	return state;
}

async function waitForLoginStatus(api: AzureAccount) {
	if (api.status !== 'Initializing') {
		return api.status;
	}
	return new Promise<typeof api.status>(resolve => {
		const subscription = api.onStatusChanged(() => {
			subscription.dispose();
			resolve(waitForLoginStatus(api));
		});
	});
}

async function findUserSettings(tokens: Token[]) {
	for (const token of tokens) {
		const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
		if (userSettings && userSettings.storageProfile) {
			return { userSettings, token };
		}
	}
}

async function requiresSetUp(reporter: TelemetryReporter) {
	sendTelemetryEvent(reporter, 'requiresSetUp');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.setUpInWeb', "First launch of Cloud Shell requires setup in the web application (https://shell.azure.com).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresSetUpOpen');
		opn('https://shell.azure.com');
	} else {
		sendTelemetryEvent(reporter, 'requiresSetUpCancel');
	}
}

async function requiresNode(reporter: TelemetryReporter) {
	sendTelemetryEvent(reporter, 'requiresNode');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.requiresNode', "Opening a Cloud Shell currently requires Node.js 6 or later to be installed (https://nodejs.org).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresNodeOpen');
		opn('https://nodejs.org');
	} else {
		sendTelemetryEvent(reporter, 'requiresNodeCancel');
	}
}

async function deploymentConflict(reporter: TelemetryReporter, os: OS) {
	sendTelemetryEvent(reporter, 'deploymentConflict');
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const cancel: MessageItem = { title: localize('azure-account.cancel', "Cancel"), isCloseAffordance: true };
	const message = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response = await window.showWarningMessage(message, ok, cancel);
	const reset = response === ok;
	sendTelemetryEvent(reporter, reset ? 'deploymentConflictReset' : 'deploymentConflictCancel');
	return reset;
}

interface Token {
	session: AzureSession;
	accessToken: string;
	refreshToken: string;
}

async function acquireToken(session: AzureSession) {
	return new Promise<Token>((resolve, reject) => {
		const credentials: any = session.credentials;
		const environment: any = session.environment;
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
			if (err) {
				reject(err);
			} else {
				resolve({
					session,
					accessToken: result.accessToken,
					refreshToken: result.refreshToken
				});
			}
		});
	});
}

export interface ExecResult {
	error: Error | null;
	stdout: string;
	stderr: string;
}


async function exec(command: string) {
	return new Promise<ExecResult>((resolve, reject) => {
		cp.exec(command, (error, stdout, stderr) => {
			(error || stderr ? reject : resolve)({ error, stdout, stderr });
		});
	});
}
