import * as request from 'request-promise';
import * as WS from 'ws';

const consoleApiVersion = '2017-08-01-preview';
const accessToken = `Bearer ${process.argv[2]}`; // TODO: process.env.CLOUD_CONSOLE_ACCESS_TOKEN (https://github.com/Microsoft/vscode/pull/30352)
let terminalIdleTimeout = 20;

function getConsoleUri() {
	return 'https://management.azure.com/providers/Microsoft.Portal/consoles/default?api-version=' + consoleApiVersion;
}

async function provisionConsole() {
	process.stdin.setRawMode!(true);

	return request({
		uri: getConsoleUri(),
		method: 'GET',
		headers: {
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'Authorization': accessToken,
			'x-ms-console-preferred-location': 'westus'
		},
		resolveWithFullResponse: true,
		json: true
	})
		.then(function (response) {
			const consoleResource = response.body;
			if (consoleResource.properties.provisioningState === 'Succeeded') {
				console.log('Connecting terminal...');
				connectTerminal(consoleResource);
			} else {
				console.log(`Sorry, your Cloud Shell failed to provision. Please retry later. Request correlation id: ${response.headers['x-ms-routing-request-id']}`);
			}
		});
}

function connectTerminal(consoleResource: any) {
	const initialGeometry = getWindowSize();
	const consoleUri = consoleResource.properties.uri;

	request({
		uri: consoleUri + '/terminals?cols=' + initialGeometry.cols + '&rows=' + initialGeometry.rows,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'Authorization': accessToken
		},
		resolveWithFullResponse: true,
		body: JSON.stringify({ tokens: [] }),
		json: true
	})
		.then(function (response) {
			const res = response.body;

			const termId = res.id;
			terminalIdleTimeout = res.idleTimeout || terminalIdleTimeout;

			connectSocket(res.socketUri);
		
			process.stdout.on('resize', () => {
				const { cols, rows } = getWindowSize();
				resize(termId, cols, rows);
			});
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
function resize(termId: string, cols: number, rows: number) {
	// TODO
	// var method = 'POST';
	// var targetUri = consoleUri + '/terminals/' + termId + '/size?cols=' + size.cols + '&rows=' + size.rows;
	// var start = Date.now();

	// $.ajax(targetUri,
	// 	{
	// 		method: method,
	// 		headers: {
	// 			'Accept': 'application/json',
	// 			'Content-Type': 'application/json',
	// 			'Authorization': accessToken
	// 		}
	// 	})
	// 	.fail(function (jqXHR, textStatus, errorThrown) {
	// 		logger.clientRequest('ACC.TERMINAL.RESIZE', {}, Date.now() - start, method, targetUri, null, null, null, null, jqXHR.status);
	// 	})
	// 	.done(function (data, textStatus, jqXHR) {
	// 		logger.clientRequest('ACC.TERMINAL.RESIZE', {}, Date.now() - start, method, targetUri, null, null, null, null, jqXHR.status);
	// 	});
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

	ws.on('error', function (event) {
		console.error('Socket error: ' + JSON.stringify(event));
	});

	ws.on('close', function () {
		console.error('Socket closed');
	});
}

provisionConsole()
	.catch(console.error);

process.stdin.resume();
