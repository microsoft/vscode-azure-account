/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as request from 'request-promise';
import * as WS from 'ws';
import { readJSON, sendData } from './ipc';

const consoleApiVersion = '2017-08-01-preview';

export enum Errors {
	DeploymentOsTypeConflict = 'DeploymentOsTypeConflict'
}

function getConsoleUri(armEndpoint: string) {
	return `${armEndpoint}/providers/Microsoft.Portal/consoles/default?api-version=${consoleApiVersion}`;
}

export interface UserSettings {
	preferredLocation: string;
	preferredOsType: string; // The last OS chosen in the portal.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	storageProfile: any;
}

export interface AccessTokens {
	resource: string;
	graph: string;
	keyVault?: string;
}

export interface ConsoleUris {
	consoleUri: string;
	terminalUri: string;
	socketUri: string;
}

export interface Size {
	cols: number;
	rows: number;
}

export async function getUserSettings(accessToken: string, armEndpoint: string): Promise<UserSettings | undefined> {
	const targetUri = `${armEndpoint}/providers/Microsoft.Portal/userSettings/cloudconsole?api-version=${consoleApiVersion}`;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const response = await request({
		uri: targetUri,
		method: 'GET',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${accessToken}`
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
	});

	// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	if (response.statusCode < 200 || response.statusCode > 299) {
		// if (response.body && response.body.error && response.body.error.message) {
		// 	console.log(`${response.body.error.message} (${response.statusCode})`);
		// } else {
		// 	console.log(response.statusCode, response.headers, response.body);
		// }
		return;
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
	return response.body && response.body.properties;
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
export async function provisionConsole(accessToken: string, armEndpoint: string, userSettings: UserSettings, osType: string): Promise<string> {
	let response = await createTerminal(accessToken, armEndpoint, userSettings, osType, true);
	for (let i = 0; i < 10; i++ , response = await createTerminal(accessToken, armEndpoint, userSettings, osType, false)) {
		if (response.statusCode < 200 || response.statusCode > 299) {
			if (response.statusCode === 409 && response.body && response.body.error && response.body.error.code === Errors.DeploymentOsTypeConflict) {
				throw new Error(Errors.DeploymentOsTypeConflict);
			} else if (response.body && response.body.error && response.body.error.message) {
				throw new Error(`${response.body.error.message} (${response.statusCode})`);
			} else {
				throw new Error(`${response.statusCode} ${response.headers} ${response.body}`);
			}
		}

		const consoleResource = response.body;
		if (consoleResource.properties.provisioningState === 'Succeeded') {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return consoleResource.properties.uri;
		} else if (consoleResource.properties.provisioningState === 'Failed') {
			break;
		}
	}
	throw new Error(`Sorry, your Cloud Shell failed to provision. Please retry later. Request correlation id: ${response.headers['x-ms-routing-request-id']}`);
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */

async function createTerminal(accessToken: string, armEndpoint: string, userSettings: UserSettings, osType: string, initial: boolean) {
	return request({
		uri: getConsoleUri(armEndpoint),
		method: initial ? 'PUT' : 'GET',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${accessToken}`,
			'x-ms-console-preferred-location': userSettings.preferredLocation
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
		body: initial ? {
			properties: {
				osType
			}
		} : undefined
	});
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function resetConsole(accessToken: string, armEndpoint: string) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const response = await request({
		uri: getConsoleUri(armEndpoint),
		method: 'DELETE',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${accessToken}`
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true
	});

	/* eslint-disable @typescript-eslint/no-unsafe-member-access */
	if (response.statusCode < 200 || response.statusCode > 299) {
		if (response.body && response.body.error && response.body.error.message) {
			throw new Error(`${response.body.error.message} (${response.statusCode})`);
		} else {
			throw new Error(`${response.statusCode} ${response.headers} ${response.body}`);
		}
	}
	/* eslint-enable @typescript-eslint/no-unsafe-member-access */
}

export async function connectTerminal(accessTokens: AccessTokens, consoleUri: string, shellType: string, initialSize: Size, progress: (i: number) => void): Promise<ConsoleUris> {

	for (let i = 0; i < 10; i++) {
		/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
		const response = await initializeTerminal(accessTokens, consoleUri, shellType, initialSize);

		if (response.statusCode < 200 || response.statusCode > 299) {
			if (response.statusCode !== 503 && response.statusCode !== 504 && response.body && response.body.error) {
				if (response.body && response.body.error && response.body.error.message) {
					throw new Error(`${response.body.error.message} (${response.statusCode})`);
				} else {
					throw new Error(`${response.statusCode} ${response.headers} ${response.body}`);
				}
			}
			await delay(1000 * (i + 1));
			progress(i + 1);
			continue;
		}

		const { id, socketUri } = response.body;
		const terminalUri = `${consoleUri}/terminals/${id}`;
		return {
			consoleUri,
			terminalUri,
			socketUri
		};
		/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
	}

	throw new Error('Failed to connect to the terminal.');
}

async function initializeTerminal(accessTokens: AccessTokens, consoleUri: string, shellType: string, initialSize: Size) {
	return request({
		// eslint-disable-next-line @typescript-eslint/restrict-plus-operands
		uri: consoleUri + '/terminals?cols=' + initialSize.cols + '&rows=' + initialSize.rows + '&shell=' + shellType,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Authorization': `Bearer ${accessTokens.resource}`
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
		body: {
			tokens: accessTokens.keyVault ? [accessTokens.graph, accessTokens.keyVault] : [accessTokens.graph]
		}
	});
}

function getWindowSize(): Size {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const stdout: any = process.stdout;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
	const windowSize: [number, number] = stdout.isTTY ? stdout.getWindowSize() : [80, 30];
	return {
		cols: windowSize[0],
		rows: windowSize[1],
	};
}

let resizeToken = {};
async function resize(accessTokens: AccessTokens, terminalUri: string) {
	const token = resizeToken = {};
	await delay(300);

	for (let i = 0; i < 10; i++) {
		if (token !== resizeToken) {
			return;
		}

		const { cols, rows } = getWindowSize();
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const response = await request({
			uri: `${terminalUri}/size?cols=${cols}&rows=${rows}`,
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${accessTokens.resource}`
			},
			simple: false,
			resolveWithFullResponse: true,
			json: true,
		});

		/* eslint-disable @typescript-eslint/no-unsafe-member-access */
		if (response.statusCode < 200 || response.statusCode > 299) {
			if (response.statusCode !== 503 && response.statusCode !== 504 && response.body && response.body.error) {
				if (response.body && response.body.error && response.body.error.message) {
					console.log(`${response.body.error.message} (${response.statusCode})`);
				} else {
					console.log(response.statusCode, response.headers, response.body);
				}
				break;
			}
			await delay(1000 * (i + 1));
			continue;
		}
		/* eslint-enable @typescript-eslint/no-unsafe-member-access */

		return;
	}

	console.log('Failed to resize terminal.');
}

function connectSocket(ipcHandle: string, url: string) {

	const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
	let agent: http.Agent | undefined = undefined;
	if (proxy) {
		agent = url.startsWith('ws:') || url.startsWith('http:') ? new HttpProxyAgent(proxy) : new HttpsProxyAgent(proxy);
	}

	const ws = new WS(url, {
		agent
	});

	ws.on('open', function () {
		process.stdin.on('data', function (data) {
			ws.send(data);
		});
		startKeepAlive();
		sendData(ipcHandle, JSON.stringify([ { type: 'status', status: 'Connected' } ]))
			.catch(err => {
				console.error(err);
			});
	});

	ws.on('message', function (data) {
		process.stdout.write(String(data));
	});

	let error = false;
	ws.on('error', function (event) {
		error = true;
		console.error('Socket error: ' + JSON.stringify(event));
	});

	ws.on('close', function () {
		console.log('Socket closed');
		sendData(ipcHandle, JSON.stringify([ { type: 'status', status: 'Disconnected' } ]))
			.catch(err => {
				console.error(err);
			});
		if (!error) {
			process.exit(0);
		}
	});

	function startKeepAlive() {
		let isAlive = true;
		ws.on('pong', () => {
			isAlive = true;
		});
		const timer = setInterval(() => {
			if (isAlive === false) {
				error = true;
				console.log('Socket timeout');
				ws.terminate();
				clearInterval(timer);
			} else {
				isAlive = false;
				ws.ping();
			}
		}, 60000);
		timer.unref();
	}
}

async function delay(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function main() {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	process.stdin.setRawMode!(true);
	process.stdin.resume();

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const ipcHandle = process.env.CLOUD_CONSOLE_IPC!;
	(async () => {
		void sendData(ipcHandle, JSON.stringify([ { type: 'size', size: getWindowSize() } ]));
		let res: http.IncomingMessage;
		// eslint-disable-next-line no-cond-assign
		while (res = await sendData(ipcHandle, JSON.stringify([ { type: 'poll' } ]))) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const message of await readJSON<any>(res)) {
				/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
				if (message.type === 'log') {
					console.log(...message.args);
				} else if (message.type === 'connect') {
					try {
						const accessTokens: AccessTokens = message.accessTokens;
						const consoleUris: ConsoleUris = message.consoleUris;
						connectSocket(ipcHandle, consoleUris.socketUri);
						process.stdout.on('resize', () => {
							resize(accessTokens, consoleUris.terminalUri)
								.catch(console.error);
						});
					} catch(err) {
						console.error(err);
						sendData(ipcHandle, JSON.stringify([ { type: 'status', status: 'Disconnected' } ]))
							.catch(err => {
								console.error(err);
							});
					}
				} else if (message.type === 'exit') {
					process.exit(message.code);
				}
				/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
			}
		}
	})()
		.catch(console.error);
}
