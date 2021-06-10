/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as FormData from 'form-data';
import { ReadStream } from 'fs';
import { DeviceTokenCredentials } from 'ms-rest-azure';
import { Socket } from 'net';
import fetch from 'node-fetch';
import * as path from 'path';
import * as semver from 'semver';
import { parse } from 'url';
import { v4 as uuid } from 'uuid';
import { commands, env, EventEmitter, MessageItem, QuickPickItem, Terminal, Uri, window } from 'vscode';
import { tokenFromRefreshToken } from './azure-account';
import { AzureAccount, AzureLoginStatus, AzureSession, CloudShell, CloudShellStatus, UploadOptions } from './azure-account.api';
import { AccessTokens, connectTerminal, ConsoleUris, Errors, getUserSettings, provisionConsole, resetConsole, Size } from './cloudConsoleLauncher';
import { createServer, Queue, readJSON } from './ipc';
import { TelemetryReporter } from './telemetry';
import { localize } from './utils/localize';

interface OS {
	id: string;
	shellName: string;
	otherOS: OS;
}

export const OSes = {
	Linux: {
		id: 'linux',
		shellName: localize('azure-account.bash', "Bash"),
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		get otherOS() { return OSes.Windows; },
	},
	Windows: {
		id: 'windows',
		shellName: localize('azure-account.powershell', "PowerShell"),
		// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
		get otherOS() { return OSes.Linux; },
	}
};

interface Deferred<T> {
	resolve: (result: T | Promise<T>) => void;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reject: (reason: any) => void;
}


function sendTelemetryEvent(reporter: TelemetryReporter, outcome: string, message?: string) {
	/* __GDPR__
	   "openCloudConsole" : {
		  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
		  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" }
	   }
	 */

	reporter.sendSanitizedEvent('openCloudConsole', message ? { outcome, message } : { outcome });
}

async function waitForConnection(this: CloudShell) {
	const handleStatus = () => {
		switch (this.status) {
			case 'Connecting':
				return new Promise<boolean>(resolve => {
					const subs = this.onStatusChanged(() => {
						subs.dispose();
						resolve(handleStatus());
					});
				});
			case 'Connected':
				return true;
			case 'Disconnected':
				return false;
			default:
				const status: never = this.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	};
	return handleStatus();
}

function uploadFile(tokens: Promise<AccessTokens>, uris: Promise<ConsoleUris>) {
	return async function (this: CloudShell, filename: string, stream: ReadStream, options: UploadOptions = {}) {
		if (options.progress) {
			options.progress.report({ message: localize('azure-account.connectingForUpload', "Connecting to upload '{0}'...", filename) });
		}
		const accessTokens = await tokens;
		const { terminalUri } = await uris;
		if (options.token && options.token.isCancellationRequested) {
			throw 'canceled';
		}
		return new Promise<void>((resolve, reject) => {
			const form = new FormData();
			form.append('uploading-file', stream, {
				filename,
				knownLength: options.contentLength
			});
			const uri = parse(`${terminalUri}/upload`);
			const req = form.submit({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
				protocol: <any>uri.protocol,
				hostname: uri.hostname,
				port: uri.port,
				path: uri.path,
				headers: {
					'Authorization': `Bearer ${accessTokens.resource}`
				},
			}, (err, res) => {
				if (err) {
					reject(err);
				} if (res && res.statusCode && (res.statusCode < 200 || res.statusCode > 299)) {
					reject(`${res.statusMessage} (${res.statusCode})`)
				} else {
					resolve();
				}
				if (res) {
					res.resume(); // Consume response.
				}
			});
			if (options.token) {
				options.token.onCancellationRequested(() => {
					reject('canceled');
					req.abort();
				});
			}
			if (options.progress) {
				req.on('socket', (socket: Socket) => {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					options.progress!.report({
						message: localize('azure-account.uploading', "Uploading '{0}'...", filename),
						increment: 0
					});
					let previous = 0;
					socket.on('drain', () => {
						const total = req.getHeader('Content-Length') as number;
						if (total) {
							const worked = Math.min(Math.round(100 * socket.bytesWritten / total), 100);
							const increment = worked - previous;
							if (increment) {
								// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
								options.progress!.report({
									message: localize('azure-account.uploading', "Uploading '{0}'...", filename),
									increment
								});
							}
							previous = worked;
						}
					});
				});
			}
		});
	}
}

export const shells: CloudShell[] = [];

export function createCloudConsole(api: AzureAccount, reporter: TelemetryReporter, osName: keyof typeof OSes): CloudShell {
	const os = OSes[osName];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let liveQueue: Queue<any> | undefined;
	const event = new EventEmitter<CloudShellStatus>();
	let deferredTerminal: Deferred<Terminal>;
	let deferredSession: Deferred<AzureSession>;
	let deferredTokens: Deferred<AccessTokens>;
	const tokensPromise = new Promise<AccessTokens>((resolve, reject) => deferredTokens = { resolve, reject });
	let deferredUris: Deferred<ConsoleUris>;
	const urisPromise = new Promise<ConsoleUris>((resolve, reject) => deferredUris = { resolve, reject });
	let deferredInitialSize: Deferred<Size>;
	const initialSizePromise = new Promise<Size>((resolve, reject) => deferredInitialSize = { resolve, reject });
	const state = {
		status: <CloudShellStatus>'Connecting',
		onStatusChanged: event.event,
		waitForConnection,
		terminal: new Promise<Terminal>((resolve, reject) => deferredTerminal = { resolve, reject }),
		session: new Promise<AzureSession>((resolve, reject) => deferredSession = { resolve, reject }),
		uploadFile: uploadFile(tokensPromise, urisPromise)
	};
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	state.terminal.catch(() => { }); // ignore
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	state.session.catch(() => { }); // ignore
	shells.push(state);
	function updateStatus(status: CloudShellStatus) {
		state.status = status;
		event.fire(state.status);
		if (status === 'Disconnected') {
			deferredTerminal.reject(status);
			deferredSession.reject(status);
			deferredTokens.reject(status);
			deferredUris.reject(status);
			shells.splice(shells.indexOf(state), 1);
			void commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);
		}
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(async function (): Promise<any> {
		void commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);

		const isWindows = process.platform === 'win32';
		if (isWindows) {
			// See below
			try {
				const { stdout } = await exec('node.exe --version');
				const version = stdout[0] === 'v' && stdout.substr(1).trim();
				if (version && semver.valid(version) && !semver.gte(version, '6.0.0')) {
					updateStatus('Disconnected');
					return requiresNode(reporter);
				}
			} catch (err) {
				updateStatus('Disconnected');
				return requiresNode(reporter);
			}
		}

		// ipc
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const queue = new Queue<any>();
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		const ipc = await createServer('vscode-cloud-console', async (req, res) => {
			let dequeue = false;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const message of await readJSON<any>(req)) {
				/* eslint-disable @typescript-eslint/no-unsafe-member-access */
				if (message.type === 'poll') {
					dequeue = true;
				} else if (message.type === 'log') {
					console.log(...message.args);
				} else if (message.type === 'size') {
					deferredInitialSize.resolve(message.size);
				} else if (message.type === 'status') {
					updateStatus(message.status);
				}
				/* eslint-enable @typescript-eslint/no-unsafe-member-access */
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
		let shellPath = path.join(__dirname, `../bin/node.${isWindows ? 'bat' : 'sh'}`);
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
				updateStatus('Disconnected');
			}
		});
		liveQueue = queue;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredTerminal!.resolve(terminal);

		const loginStatus = await waitForLoginStatus(api);
		if (loginStatus !== 'LoggedIn') {
			if (loginStatus === 'LoggingIn') {
				queue.push({ type: 'log', args: [localize('azure-account.loggingIn', "Signing in...")] });
			}
			if (!(await api.waitForLogin())) {
				queue.push({ type: 'log', args: [localize('azure-account.loginNeeded', "Sign in needed.")] });
				sendTelemetryEvent(reporter, 'requiresLogin');
				await commands.executeCommand('azure-account.askForLogin');
				if (!(await api.waitForLogin())) {
					queue.push({ type: 'exit' });
					updateStatus('Disconnected');
					return;
				}
			}
		}

		let token: Token | undefined = undefined;
		await api.waitForSubscriptions();
		const sessions = [...new Set(api.subscriptions.map(subscription => subscription.session))]; // Only consider those with at least one subscription.
		if (sessions.length > 1) {
			queue.push({ type: 'log', args: [localize('azure-account.selectDirectory', "Select directory...")] });
			const fetchingDetails = Promise.all(sessions.map(session => fetchTenantDetails(session)
				.catch(err => {
					console.error(err);
					return undefined;
				})))
				.then(tenantDetails => tenantDetails.filter(details => details));
			const pick = await window.showQuickPick<QuickPickItem & { session: AzureSession }>(fetchingDetails
				.then(tenantDetails => tenantDetails.map(details => {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					const tenantDetails = details!.tenantDetails;
					const defaultDomain = tenantDetails.verifiedDomains.find(domain => domain.default);
					return {
						label: tenantDetails.displayName,
						description: defaultDomain && defaultDomain.name,
						// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
						session: details!.session
					};
				}).sort((a, b) => a.label.localeCompare(b.label))), {
					placeHolder: localize('azure-account.selectDirectoryPlaceholder', "Select directory"),
					ignoreFocusOut: true // The terminal opens concurrently and can steal focus (#77).
				});
			if (!pick) {
				sendTelemetryEvent(reporter, 'noTenantPicked');
				queue.push({ type: 'exit' });
				updateStatus('Disconnected');
				return;
			}
			token = await acquireToken(pick.session);
		} else if (sessions.length === 1) {
			token = await acquireToken(sessions[0]);
		}

		const result = token && await findUserSettings(token);
		if (!result) {
			queue.push({ type: 'log', args: [localize('azure-account.setupNeeded', "Setup needed.")] });
			await requiresSetUp(reporter);
			queue.push({ type: 'exit' });
			updateStatus('Disconnected');
			return;
		}
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredSession!.resolve(result.token.session);

		// provision
		let consoleUri: string;
		const session = result.token.session;
		const accessToken = result.token.accessToken;
		const armEndpoint = session.environment.resourceManagerEndpointUrl;
		const provision = async () => {
			consoleUri = await provisionConsole(accessToken, armEndpoint, result.userSettings, OSes.Linux.id);
			sendTelemetryEvent(reporter, 'provisioned');
		}
		try {
			queue.push({ type: 'log', args: [localize('azure-account.requestingCloudConsole', "Requesting a Cloud Shell...")] });
			await provision();
		} catch (err) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (err && err.message === Errors.DeploymentOsTypeConflict) {
				const reset = await deploymentConflict(reporter, os);
				if (reset) {
					await resetConsole(accessToken, armEndpoint);
					return provision();
				} else {
					queue.push({ type: 'exit' });
					updateStatus('Disconnected');
					return;
				}
			} else {
				throw err;
			}
		}

		// Additional tokens
		const [graphToken, keyVaultToken] = await Promise.all([
			tokenFromRefreshToken(session.environment, result.token.refreshToken, session.tenantId, session.environment.activeDirectoryGraphResourceId),
			session.environment.keyVaultDnsSuffix
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				? tokenFromRefreshToken(session.environment, result.token.refreshToken, session.tenantId, `https://${session.environment.keyVaultDnsSuffix!.substr(1)}`)
				: Promise.resolve(undefined)
		]);
		const accessTokens: AccessTokens = {
			resource: accessToken,
			graph: graphToken.accessToken,
			keyVault: keyVaultToken && keyVaultToken.accessToken
		};
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredTokens!.resolve(accessTokens);

		// Connect to terminal
		const connecting = localize('azure-account.connectingTerminal', "Connecting terminal...");
		queue.push({ type: 'log', args: [connecting] });
		const progress = (i: number) => {
			queue.push({ type: 'log', args: [`\x1b[A${connecting}${'.'.repeat(i)}`] });
		};
		const initialSize = await initialSizePromise;
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const consoleUris = await connectTerminal(accessTokens, consoleUri!, /* TODO: Separate Shell from OS */ osName === 'Linux' ? 'bash' : 'pwsh', initialSize, progress);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		deferredUris!.resolve(consoleUris);

		// Connect to WebSocket
		queue.push({
			type: 'connect',
			accessTokens,
			consoleUris
		});
	})().catch(err => {
		/* eslint-disable @typescript-eslint/no-unsafe-member-access */
		console.error(err && err.stack || err);
		updateStatus('Disconnected');
		sendTelemetryEvent(reporter, 'error', String(err && err.message || err));
		if (liveQueue) {
			liveQueue.push({ type: 'log', args: [localize('azure-account.error', "Error: {0}", String(err && err.message || err))] });
		}
		/* eslint-enable @typescript-eslint/no-unsafe-member-access */
	});
	return state;
}

async function waitForLoginStatus(api: AzureAccount) {
	if (api.status !== 'Initializing') {
		return api.status;
	}
	return new Promise<AzureLoginStatus>(resolve => {
		const subscription = api.onStatusChanged(() => {
			subscription.dispose();
			resolve(waitForLoginStatus(api));
		});
	});
}

async function findUserSettings(token: Token) {
	const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
	if (userSettings && userSettings.storageProfile) {
		return { userSettings, token };
	}
}

async function requiresSetUp(reporter: TelemetryReporter) {
	sendTelemetryEvent(reporter, 'requiresSetUp');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message = localize('azure-account.setUpInWeb', "First launch of Cloud Shell in a directory requires setup in the web application (https://shell.azure.com).");
	const response = await window.showInformationMessage(message, open);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresSetUpOpen');
		void env.openExternal(Uri.parse('https://shell.azure.com'));
	} else {
		sendTelemetryEvent(reporter, 'requiresSetUpCancel');
	}
}

async function requiresNode(reporter: TelemetryReporter) {
	sendTelemetryEvent(reporter, 'requiresNode');
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message = localize('azure-account.requiresNode', "Opening a Cloud Shell currently requires Node.js 6 or later to be installed (https://nodejs.org).");
	const response = await window.showInformationMessage(message, open);
	if (response === open) {
		sendTelemetryEvent(reporter, 'requiresNodeOpen');
		void env.openExternal(Uri.parse('https://nodejs.org'));
	} else {
		sendTelemetryEvent(reporter, 'requiresNodeCancel');
	}
}

async function deploymentConflict(reporter: TelemetryReporter, os: OS) {
	sendTelemetryEvent(reporter, 'deploymentConflict');
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const message = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response = await window.showWarningMessage(message, ok);
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
		/* eslint-disable @typescript-eslint/no-explicit-any */
		const credentials: any = session.credentials;
		const environment: any = session.environment;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
		/* eslint-enable @typescript-eslint/no-explicit-any */
			if (err) {
				reject(err);
			} else {
				resolve({
					session,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
					accessToken: result.accessToken,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
					refreshToken: result.refreshToken
				});
			}
		});
	});
}

interface TenantDetails {
	objectId: string;
	displayName: string;
	verifiedDomains: { name: string; default: boolean; }[];
}

async function fetchTenantDetails(session: AzureSession): Promise<{ session: AzureSession, tenantDetails: TenantDetails }> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
	const { username, clientId, tokenCache, domain } = <any>session.credentials;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const graphCredentials = new DeviceTokenCredentials({ username, clientId, tokenCache, domain, tokenAudience: 'graph' });

	const apiVersion = '1.6';
	const requestUrl = `https://graph.windows.net/${encodeURIComponent(session.tenantId)}/tenantDetails?api-version=${encodeURIComponent(apiVersion)}`;

	return new Promise((resolve, reject) => {
		// eslint-disable-next-line @typescript-eslint/no-misused-promises, @typescript-eslint/no-explicit-any
		graphCredentials.getToken(async (err: Error, result: any) => {
			if (err) {
				reject(err);
				return;
			}

			if (result) {
				try {
					const response = await fetch(requestUrl, {
						headers: {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
							Authorization: `Bearer ${result.accessToken}`,
							"x-ms-client-request-id": uuid(),
							"Content-Type": 'application/json; charset=utf-8'
						}
					});
	
					if (response.ok) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
						const json = await response.json();
						resolve({
							session,
							// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
							tenantDetails: json.value[0]
						});
					} else {
						reject(response.statusText)
					}
				} catch (e) {
					reject(e);
				}
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
