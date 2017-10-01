import * as request from 'request-promise';
import * as WS from 'ws';

const consoleApiVersion = '2017-08-01-preview';
let terminalIdleTimeout = 20;

function getARMEndpoint() {
	return 'https://management.azure.com'; // TODO
}

function getConsoleUri() {
	return `${getARMEndpoint()}/providers/Microsoft.Portal/consoles/default?api-version=${consoleApiVersion}`;
}

interface UserSettings {
	preferredLocation: string;
	preferredOsType: string;
}

async function getUserSettings(accessToken: string) {
	const targetUri = `${getARMEndpoint()}/providers/Microsoft.Portal/userSettings/cloudconsole?api-version=${consoleApiVersion}`;
	return request({
		uri: targetUri,
		method: 'GET',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': accessToken
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
	});
}

async function provisionConsole(accessToken: string, userSettings: UserSettings) {
	process.stdin.setRawMode!(true);

	console.log('Requesting a Cloud Shell...');
	for (let response = await createTerminal(accessToken, userSettings, true); ; response = await createTerminal(accessToken, userSettings, false)) {
		if (response.statusCode < 200 || response.statusCode > 299) {
			if (response.body && response.body.error && response.body.error.message) {
				console.log(`${response.body.error.message} (${response.statusCode})`);
			} else {
				console.log(response.statusCode, response.headers, response.body);
			}
			return;
		}

		const consoleResource = response.body;
		if (consoleResource.properties.provisioningState === 'Succeeded') {
			return connectTerminal(accessToken, consoleResource);
		} else if (consoleResource.properties.provisioningState === 'Failed') {
			console.log(`Sorry, your Cloud Shell failed to provision. Please retry later. Request correlation id: ${response.headers['x-ms-routing-request-id']}`);
			return;
		}
		console.log('.');
	}
}

async function createTerminal(accessToken: string, userSettings: UserSettings, initial: boolean) {
	return request({
		uri: getConsoleUri(),
		method: initial ? 'PUT' : 'GET',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': accessToken,
			'x-ms-console-preferred-location': userSettings.preferredLocation
		},
		simple: false,
		resolveWithFullResponse: true,
		json: true,
		body: initial ? {
			properties: {
				osType: userSettings.preferredOsType
			}
		} : undefined
	});
}

async function connectTerminal(accessToken: string, consoleResource: any) {
	console.log('Connecting terminal...');
	const consoleUri = consoleResource.properties.uri;

	for (let i = 0; i < 5; i++) {
		const response = await initializeTerminal(accessToken, consoleUri);

		if (response.statusCode < 200 || response.statusCode > 299) {
			if (response.statusCode !== 404) {
				if (response.body && response.body.error && response.body.error.message) {
					console.log(`${response.body.error.message} (${response.statusCode})`);
				} else {
					console.log(response.statusCode, response.headers, response.body);
				}
			}
			await delay(1000 * (i + 1));
			console.log('.');
			continue;
		}

		const res = response.body;
		const termId = res.id;
		terminalIdleTimeout = res.idleTimeout || terminalIdleTimeout;

		connectSocket(res.socketUri);

		process.stdout.on('resize', () => {
			const { cols, rows } = getWindowSize();
			resize(accessToken, consoleUri, termId, cols, rows)
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
			'Authorization': accessToken
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

async function resize(accessToken: string, consoleUri: string, termId: string, cols: number, rows: number) {
	return request({
		uri: consoleUri + '/terminals/' + termId + '/size?cols=' + cols + '&rows=' + rows,
		method: 'POST',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': accessToken
		}
	});
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

(async () => {
	for (const token of process.argv.slice(2)) {
		const accessToken = `Bearer ${token}`; // TODO: process.env.CLOUD_CONSOLE_ACCESS_TOKEN (https://github.com/Microsoft/vscode/pull/30352)
		const response = await getUserSettings(accessToken);
		if (response.statusCode < 200 || response.statusCode > 299) {
			// if (response.body && response.body.error && response.body.error.message) {
			// 	console.log(`${response.body.error.message} (${response.statusCode})`);
			// } else {
			// 	console.log(response.statusCode, response.headers, response.body);
			// }
			continue;
		}

		const userSettings = response.body && response.body.properties;
		if (!userSettings || !userSettings.storageProfile) {
			// console.log(response.body);
			continue;
		}

		return provisionConsole(accessToken, userSettings);
	}

	console.log('No user settings with configured storage account found. Open cloud console in portal to configure first: https://portal.azure.com');

})().catch(console.error);

process.stdin.resume();
