//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AzureEnvironment } from 'ms-rest-azure';
import { TokenResponse, AuthenticationContext } from 'adal-node';

const redirectUrlAAD = 'https://vscode-redirect.azurewebsites.net/';
const redirectUrlADFS = 'http://127.0.0.1:9472/';

export function isADFS(environment: AzureEnvironment) {
	const u = url.parse(environment.activeDirectoryEndpointUrl);
	const pathname = (u.pathname || '').toLowerCase();
	return pathname === '/adfs' || pathname.startsWith('/adfs/');
}

export async function checkRedirectServer(adfs: boolean) {
	if (adfs) {
		return true;
	}
	let timer: NodeJS.Timer | undefined;
	const promise = new Promise<boolean>(resolve => {
		const req = https.get({
			...url.parse(`${redirectUrlAAD}?state=3333,cccc`),
		}, res => {
			const key = Object.keys(res.headers)
				.find(key => key.toLowerCase() === 'location');
			const location = key && res.headers[key]
			resolve(res.statusCode === 302 && typeof location === 'string' && location.startsWith('http://127.0.0.1:3333/callback'));
		});
		req.on('error', err => {
			console.error(err);
			resolve(false);
		});
		req.on('close', () => {
			resolve(false);
		});
		timer = setTimeout(() => {
			resolve(false);
			req.abort();
		}, 5000);
	});
	function cancelTimer() {
		if (timer) {
			clearTimeout(timer);
		}
	}
	promise.then(cancelTimer, cancelTimer);
	return promise;
}

export async function login(clientId: string, environment: AzureEnvironment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>) {
	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, redirectPromise, codePromise } = createServer(nonce);

	try {
		const port = await startServer(server);
		await openUri(`http://localhost:${port}/signin`);
		const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);

		const redirectReq = await redirectPromise;
		clearTimeout(redirectTimer);
		const host = redirectReq.req.headers.host || '';
		const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
		const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

		const state = `${updatedPort},${encodeURIComponent(nonce)}`;
		const redirectUrl = adfs ? redirectUrlADFS : redirectUrlAAD;
		const signInUrl = `${environment.activeDirectoryEndpointUrl}${tenantId}/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`;
		redirectReq.res.writeHead(302, { Location: signInUrl })
		redirectReq.res.end();

		const codeRes = await codePromise;
		const res = codeRes.res;
		try {
			if ('err' in codeRes) {
				throw codeRes.err;
			}
			const tokenResponse = await tokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, codeRes.code);
			res.writeHead(302, { Location: '/' });
			res.end();
			return tokenResponse;
		} catch (err) {
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unkown error')}` });
			res.end();
			throw err;
		}
	} finally {
		setTimeout(() => {
			server.close();
		}, 5000);
	}
}

interface Deferred<T> {
	resolve: (result: T | Promise<T>) => void;
	reject: (reason: any) => void;
}

function createServer(nonce: string) {
	type RedirectResult = { req: http.ServerRequest; res: http.ServerResponse; };
	let deferredRedirect: Deferred<RedirectResult>;
	const redirectPromise = new Promise<RedirectResult>((resolve, reject) => deferredRedirect = { resolve, reject });

	type CodeResult = { code: string; res: http.ServerResponse; } | { err: any; res: http.ServerResponse; };
	let deferredCode: Deferred<CodeResult>;
	const codePromise = new Promise<CodeResult>((resolve, reject) => deferredCode = { resolve, reject });

	const codeTimer = setTimeout(() => {
		deferredCode.reject(new Error('Timeout waiting for code'));
	}, 5 * 60 * 1000);
	function cancelCodeTimer() {
		clearTimeout(codeTimer);
	}
	const server = http.createServer(function (req, res) {
		const reqUrl = url.parse(req.url!, /* parseQueryString */ true);
		switch (reqUrl.pathname) {
			case '/signin':
				deferredRedirect.resolve({ req, res });
				break;
			case '/':
				sendFile(res, path.join(__dirname, '../codeFlowResult/index.html'), 'text/html; charset=utf-8');
				break;
			case '/main.css':
				sendFile(res, path.join(__dirname, '../codeFlowResult/main.css'), 'text/css; charset=utf-8');
				break;
			case '/callback':
				deferredCode.resolve(callback(nonce, reqUrl)
					.then(code => ({ code, res }), err => ({ err, res })));
				break;
			default:
				res.writeHead(404);
				res.end();
				break;
		}
	});
	codePromise.then(cancelCodeTimer, cancelCodeTimer);
	return {
		server,
		redirectPromise,
		codePromise
	};
}

function sendFile(res: http.ServerResponse, filepath: string, contentType: string) {
	fs.readFile(filepath, (err, body) => {
		if (err) {
			console.error(err);
		} else {
			res.writeHead(200, {
				'Content-Length': body.length,
				'Content-Type': contentType
			});
			res.end(body);
		}
	});
}

async function startServer(server: http.Server) {
	let portTimer: NodeJS.Timer;
	function cancelPortTimer() {
		clearTimeout(portTimer);
	}
	const port = new Promise<number>((resolve, reject) => {
		portTimer = setTimeout(() => {
			reject(new Error('Timeout waiting for port'));
		}, 5000);
		server.on('listening', () => {
			const address = server.address();
			resolve(address.port);
		});
		server.on('error', err => {
			reject(err);
		});
		server.on('close', () => {
			reject(new Error('Closed'));
		});
		server.listen(0, '127.0.0.1');
	});
	port.then(cancelPortTimer, cancelPortTimer);
	return port;
}

async function callback(nonce: string, reqUrl: url.Url): Promise<string> {
	let error = reqUrl.query.error_description || reqUrl.query.error;

	if (!error) {
		const state = reqUrl.query.state || '';
		const receivedNonce = (state.split(',')[1] || '').replace(/ /g, '+');
		if (receivedNonce !== nonce) {
			error = 'Nonce does not match.';
		}
	}

	const code = reqUrl.query.code;
	if (!error && code) {
		return code;
	}
	throw new Error(error || 'No code received.');
}

async function tokenWithAuthorizationCode(clientId: string, environment: AzureEnvironment, redirectUrl: string, tenantId: string, code: string) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`);
		context.acquireTokenWithAuthorizationCode(code, redirectUrl, environment.activeDirectoryResourceId, clientId, <any>undefined, (err, response) => {
			if (err) {
				reject(err);
			} if (response && response.error) {
				reject(new Error(`${response.error}: ${response.errorDescription}`));
			} else {
				resolve(<TokenResponse>response);
			}
		});
	});
}

if (require.main === module) {
	login('aebc6443-996d-45c2-90f0-388ff96faa56', AzureEnvironment.Azure, false, 'common', async uri => console.log(`Open: ${uri}`), async () => console.log('Browser did not connect to local server within 10 seconds.'))
		.catch(console.error);
}
