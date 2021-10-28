/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, commands, MessageItem, EventEmitter, Terminal, Uri, env, QuickPickItem } from 'vscode';
import { AzureAccount, AzureSession, CloudShell, CloudShellStatus, UploadOptions } from './azure-account.api';
import { tokenFromRefreshToken } from './azure-account';
import { createServer, readJSON, Queue } from './ipc';
import { getUserSettings, provisionConsole, Errors, resetConsole, AccessTokens, connectTerminal, ConsoleUris, Size } from './cloudConsoleLauncher';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as cp from 'child_process';
import * as semver from 'semver';
import { DeviceTokenCredentials } from 'ms-rest-azure';
import { ReadStream } from 'fs';
import * as FormData from 'form-data';
import { parse } from 'url';
import { Socket } from 'net';
import { v4 as uuid } from 'uuid';
import fetch from 'node-fetch';
import { callWithTelemetryAndErrorHandlingSync, IActionContext } from 'vscode-azureextensionui';
// const adal = require('adal-node');

// function turnOnLogging() {
//   var log = adal.Logging;
//   log.setLoggingOptions(
//   {
//     level : log.LOGGING_LEVEL.VERBOSE,
//     log : function(level: number, message: string, error: any) {
//       console.log(message);
//       if (error) {
//         console.log(error);
//       }
//     }
//   });
// }
// turnOnLogging();

const localize = nls.loadMessageBundle();

interface OS {
	id: string;
	shellName: string;
	otherOS: OS;
}

export const OSes = {
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

interface Deferred<T> {
	resolve: (result: T | Promise<T>) => void;
	reject: (reason: any) => void;
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

export function createCloudConsole(api: AzureAccount, osName: keyof typeof OSes): CloudShell {
	return (callWithTelemetryAndErrorHandlingSync('azure-account.createCloudConsole', (context: IActionContext) => {
		const os = OSes[osName];
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
		state.terminal.catch(() => { }); // ignore
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
				commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);
			}
		}
		(async function (): Promise<any> {
			commands.executeCommand('setContext', 'openCloudConsoleCount', `${shells.length}`);

			const isWindows = process.platform === 'win32';
			if (isWindows) {
				// See below
				try {
					const { stdout } = await exec('node.exe --version');
					const version = stdout[0] === 'v' && stdout.substr(1).trim();
					if (version && semver.valid(version) && !semver.gte(version, '6.0.0')) {
						updateStatus('Disconnected');
						return requiresNode(context);
					}
				} catch (err) {
					updateStatus('Disconnected');
					return requiresNode(context);
				}
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
					} else if (message.type === 'size') {
						deferredInitialSize.resolve(message.size);
					} else if (message.type === 'status') {
						updateStatus(message.status);
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
			deferredTerminal!.resolve(terminal);

			const loginStatus = await waitForLoginStatus(api);
			if (loginStatus !== 'LoggedIn') {
				if (loginStatus === 'LoggingIn') {
					queue.push({ type: 'log', args: [localize('azure-account.loggingIn', "Signing in...")] });
				}
				if (!(await api.waitForLogin())) {
					queue.push({ type: 'log', args: [localize('azure-account.loginNeeded', "Sign in needed.")] });
					context.telemetry.properties.outcome = 'requiresLogin';
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
						const tenantDetails = details!.tenantDetails;
						const defaultDomain = tenantDetails.verifiedDomains.find(domain => domain.default);
						return {
							label: tenantDetails.displayName,
							description: defaultDomain && defaultDomain.name,
							session: details!.session
						};
					}).sort((a, b) => a.label.localeCompare(b.label))), {
						placeHolder: localize('azure-account.selectDirectoryPlaceholder', "Select directory"),
						ignoreFocusOut: true // The terminal opens concurrently and can steal focus (#77).
					});
				if (!pick) {
					context.telemetry.properties.outcome = 'noTenantPicked';

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
				await requiresSetUp(context);
				queue.push({ type: 'exit' });
				updateStatus('Disconnected');
				return;
			}
			deferredSession!.resolve(result.token.session);

			// provision
			let consoleUri: string;
			const session = result.token.session;
			const accessToken = result.token.accessToken;
			const armEndpoint = session.environment.resourceManagerEndpointUrl;
			const provision = async () => {
				consoleUri = await provisionConsole(accessToken, armEndpoint, result.userSettings, OSes.Linux.id);
				context.telemetry.properties.outcome = 'provisioned';
			}
			try {
				queue.push({ type: 'log', args: [localize('azure-account.requestingCloudConsole', "Requesting a Cloud Shell...")] });
				await provision();
			} catch (err) {
				if (err && err.message === Errors.DeploymentOsTypeConflict) {
					const reset = await deploymentConflict(context, os);
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
					? tokenFromRefreshToken(session.environment, result.token.refreshToken, session.tenantId, `https://${session.environment.keyVaultDnsSuffix!.substr(1)}`)
					: Promise.resolve(undefined)
			]);
			const accessTokens: AccessTokens = {
				resource: accessToken,
				graph: graphToken.accessToken,
				keyVault: keyVaultToken && keyVaultToken.accessToken
			};
			deferredTokens!.resolve(accessTokens);

			// Connect to terminal
			const connecting = localize('azure-account.connectingTerminal', "Connecting terminal...");
			queue.push({ type: 'log', args: [connecting] });
			const progress = (i: number) => {
				queue.push({ type: 'log', args: [`\x1b[A${connecting}${'.'.repeat(i)}`] });
			};
			const initialSize = await initialSizePromise;
			const consoleUris = await connectTerminal(accessTokens, consoleUri!, /* TODO: Separate Shell from OS */ osName === 'Linux' ? 'bash' : 'pwsh', initialSize, progress);
			deferredUris!.resolve(consoleUris);

			// Connect to WebSocket
			queue.push({
				type: 'connect',
				accessTokens,
				consoleUris
			});
		})().catch(err => {
			console.error(err && err.stack || err);
			updateStatus('Disconnected');
			context.telemetry.properties.outcome = 'error';
			context.telemetry.properties.message = String(err && err.message || err);
			if (liveQueue) {
				liveQueue.push({ type: 'log', args: [localize('azure-account.error', "Error: {0}", String(err && err.message || err))] });
			}
		});
		return state;
	}))!;
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

async function findUserSettings(token: Token) {
	const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
	if (userSettings && userSettings.storageProfile) {
		return { userSettings, token };
	}
}

async function requiresSetUp(context: IActionContext) {
	context.telemetry.properties.outcome = 'requiresSetUp';
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message = localize('azure-account.setUpInWeb', "First launch of Cloud Shell in a directory requires setup in the web application (https://shell.azure.com).");
	const response = await window.showInformationMessage(message, open);
	if (response === open) {
		context.telemetry.properties.outcome = 'requiresSetUpOpen';
		env.openExternal(Uri.parse('https://shell.azure.com'));
	} else {
		context.telemetry.properties.outcome = 'requiresSetUpCancel';
	}
}

async function requiresNode(context: IActionContext) {
	context.telemetry.properties.outcome = 'requiresNode';
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const message = localize('azure-account.requiresNode', "Opening a Cloud Shell currently requires Node.js 6 or later to be installed (https://nodejs.org).");
	const response = await window.showInformationMessage(message, open);
	if (response === open) {
		context.telemetry.properties.outcome = 'requiresNodeOpen';
		env.openExternal(Uri.parse('https://nodejs.org'));
	} else {
		context.telemetry.properties.outcome = 'requiresNodeCancel';
	}
}

async function deploymentConflict(context: IActionContext, os: OS) {
	context.telemetry.properties.outcome = 'deploymentConflict';
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const message = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response = await window.showWarningMessage(message, ok);
	const reset = response === ok;
	context.telemetry.properties.outcome = reset ? 'deploymentConflictReset' : 'deploymentConflictCancel';
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

interface TenantDetails {
	objectId: string;
	displayName: string;
	verifiedDomains: { name: string; default: boolean; }[];
}

async function fetchTenantDetails(session: AzureSession): Promise<{ session: AzureSession, tenantDetails: TenantDetails }> {
	const { username, clientId, tokenCache, domain } = <any>session.credentials;
	const graphCredentials = new DeviceTokenCredentials({ username, clientId, tokenCache, domain, tokenAudience: 'graph' });

	const apiVersion = '1.6';
	const requestUrl = `https://graph.windows.net/${encodeURIComponent(session.tenantId)}/tenantDetails?api-version=${encodeURIComponent(apiVersion)}`;

	return new Promise((resolve, reject) => {
		graphCredentials.getToken(async (err: Error, result: any) => {
			if (err) {
				reject(err);
				return;
			}

			if (result) {
				try {
					const response = await fetch(requestUrl, {
						headers: {
							Authorization: `Bearer ${result.accessToken}`,
							"x-ms-client-request-id": uuid(),
							"Content-Type": 'application/json; charset=utf-8'
						}
					});

					if (response.ok) {
						const json = await response.json();
						resolve({
							session,
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
