import * as request from 'request-promise';
import * as WS from 'ws';
import * as http from 'http';
import { sendData, readJSON } from './ipc';

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
	storageProfile: any;
}

export async function getUserSettings(accessToken: string, armEndpoint: string): Promise<UserSettings | undefined> {
	const targetUri = `${armEndpoint}/providers/Microsoft.Portal/userSettings/cloudconsole?api-version=${consoleApiVersion}`;
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

	if (response.statusCode < 200 || response.statusCode > 299) {
		// if (response.body && response.body.error && response.body.error.message) {
		// 	console.log(`${response.body.error.message} (${response.statusCode})`);
		// } else {
		// 	console.log(response.statusCode, response.headers, response.body);
		// }
		return;
	}

	return response.body && response.body.properties;
}

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
			return consoleResource.properties.uri;
		} else if (consoleResource.properties.provisioningState === 'Failed') {
			break;
		}
	}
	throw new Error(`Sorry, your Cloud Shell failed to provision. Please retry later. Request correlation id: ${response.headers['x-ms-routing-request-id']}`);
}

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

export async function resetConsole(accessToken: string, armEndpoint: string) {
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

	if (response.statusCode < 200 || response.statusCode > 299) {
		if (response.body && response.body.error && response.body.error.message) {
			throw new Error(`${response.body.error.message} (${response.statusCode})`);
		} else {
			throw new Error(`${response.statusCode} ${response.headers} ${response.body}`);
		}
	}
}

async function connectTerminal(accessToken: string, consoleUri: string) {
	console.log('Connecting terminal...');

	for (let i = 0; i < 10; i++) {
		const response = await initializeTerminal(accessToken, consoleUri);

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
			console.log(`\x1b[AConnecting terminal...${'.'.repeat(i + 1)}`);
			continue;
		}

		const res = response.body;
		const termId = res.id;
		// terminalIdleTimeout = res.idleTimeout || terminalIdleTimeout;

		connectSocket(res.socketUri);

		process.stdout.on('resize', () => {
			resize(accessToken, consoleUri, termId)
				.catch(console.error);
		});

		return;
	}

	console.log('Failed to connect to the terminal.');
}

async function initializeTerminal(accessToken: string, consoleUri: string) {
	const initialGeometry = getWindowSize();
	return request({
		uri: consoleUri + '/terminals?cols=' + initialGeometry.cols + '&rows=' + initialGeometry.rows,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Authorization': `Bearer ${accessToken}`
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
		body: {
			tokens: []
		}
	});
}

function getWindowSize() {
	const stdout: any = process.stdout;
	const windowSize: [number, number] = stdout.isTTY ? stdout.getWindowSize() : [80, 30];
	return {
		cols: windowSize[0],
		rows: windowSize[1],
	};
}

let resizeToken = {};
async function resize(accessToken: string, consoleUri: string, termId: string) {
	const token = resizeToken = {};
	await delay(300);

	for (let i = 0; i < 10; i++) {
		if (token !== resizeToken) {
			return;
		}

		const { cols, rows } = getWindowSize();
		const response = await request({
			uri: consoleUri + '/terminals/' + termId + '/size?cols=' + cols + '&rows=' + rows,
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${accessToken}`
			},
			simple: false,
			resolveWithFullResponse: true,
			json: true,
		});

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

		return;
	}

	console.log('Failed to resize terminal.');
}

function connectSocket(url: string) {

	const ws = new WS(url);

	ws.on('open', function () {
		process.stdin.on('data', function (data) {
			ws.send(data);
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
		if (!error) {
			process.exit(0);
		}
	});
}

async function delay(ms: number) {
	return new Promise<void>(resolve => setTimeout(resolve, ms));
}

export function main() {
	process.stdin.setRawMode!(true);
	process.stdin.resume();

	const ipcHandle = process.env.CLOUD_CONSOLE_IPC!;
	(async () => {
		let res: http.IncomingMessage;
		while (res = await sendData(ipcHandle, JSON.stringify([]))) {
			for (const message of await readJSON<any>(res)) {
				if (message.type === 'log') {
					console.log(...message.args);
				} else if (message.type === 'connect') {
					connectTerminal(message.accessToken, message.consoleUri)
						.catch(console.error);
				} else if (message.type === 'exit') {
					process.exit(message.code);
				}
			}
		}
	})()
		.catch(console.error);
}
