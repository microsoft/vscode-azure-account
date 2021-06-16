//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { TokenResponse } from 'adal-node';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { redirectUrlAAD, redirectUrlADFS } from './constants';
import { createServer, createTerminateServer, startServer } from './server';
import { tokenWithAuthorizationCode } from './tokens';

let terminateServer: () => Promise<void>;

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
function parseQuery(uri: vscode.Uri): any {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	public handleUri(uri: vscode.Uri) {
		this.fire(uri);
	}
}

const handler = new UriEventHandler();

vscode.window.registerUriHandler(handler);

async function exchangeCodeForToken(clientId: string, environment: Environment, tenantId: string, callbackUri: string, state: string) {
	let uriEventListener: vscode.Disposable;
	return new Promise((resolve: (value: TokenResponse) => void , reject) => {
		uriEventListener = handler.event(async (uri: vscode.Uri) => {
			try {
				/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
				const query = parseQuery(uri);
				const code = query.code;
	
				// Workaround double encoding issues of state
				if (query.state !== state && decodeURIComponent(query.state) !== state) {
					throw new Error('State does not match.');
				}
				/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
	
				resolve(await tokenWithAuthorizationCode(clientId, environment, callbackUri, tenantId, code));
			} catch (err) {
				reject(err);
			}
		});
	}).then(result => {
		uriEventListener.dispose()
		return result;
	}).catch(err => {
		uriEventListener.dispose();
		throw err;
	});
}

function getCallbackEnvironment(callbackUri: vscode.Uri): string {
	if (callbackUri.authority.endsWith('.workspaces.github.com') || callbackUri.authority.endsWith('.github.dev')) {
		return `${callbackUri.authority},`;
	}

	switch (callbackUri.authority) {
		case 'online.visualstudio.com':
			return 'vso,';
		case 'online-ppe.core.vsengsaas.visualstudio.com':
			return 'vsoppe,';
		case 'online.dev.core.vsengsaas.visualstudio.com':
			return 'vsodev,';
		case 'canary.online.visualstudio.com':
			return 'vsocanary,';
		default:
			return '';
	}
}

async function loginWithoutLocalServer(clientId: string, environment: Environment, adfs: boolean, tenantId: string): Promise<TokenResponse> {
	const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://ms-vscode.azure-account`));
	const callback = redirectUrlAAD;
	const nonce = crypto.randomBytes(16).toString('base64');
	const port = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
	const callbackEnvironment = getCallbackEnvironment(callbackUri);
	const state = `${callbackEnvironment}${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
	const signInUrl = `${environment.activeDirectoryEndpointUrl}${adfs ? '' : `${tenantId}/`}oauth2/authorize`;
	let uri = vscode.Uri.parse(signInUrl);
	uri = uri.with({
		query: `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${callback}&state=${state}&resource=${environment.activeDirectoryResourceId}&prompt=select_account`
	});
	void vscode.env.openExternal(uri);

	const timeoutPromise = new Promise((resolve: (value: TokenResponse) => void, reject) => {
		const wait = setTimeout(() => {
			clearTimeout(wait);
			reject('Login timed out.');
		}, 1000 * 60 * 5)
	});

	return Promise.race([exchangeCodeForToken(clientId, environment, tenantId, callback, state), timeoutPromise]);
}

export async function login(clientId: string, environment: Environment, adfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>): Promise<TokenResponse> {
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		return loginWithoutLocalServer(clientId, environment, adfs, tenantId);
	}

	if (adfs && terminateServer) {
		await terminateServer();
	}

	const nonce = crypto.randomBytes(16).toString('base64');
	const { server, redirectPromise, codePromise } = createServer(nonce);

	if (adfs) {
		terminateServer = createTerminateServer(server);
	}

	try {
		const port = await startServer(server, adfs);
		await openUri(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`);
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);

		const redirectReq = await redirectPromise;
		if ('err' in redirectReq) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const { err, res } = redirectReq;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			res.end();
			throw err;
		}

		clearTimeout(redirectTimer);
		const host = redirectReq.req.headers.host || '';
		const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
		const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

		const state = `${updatedPort},${encodeURIComponent(nonce)}`;
		const redirectUrl = adfs ? redirectUrlADFS : redirectUrlAAD;
		const signInUrl = `${environment.activeDirectoryEndpointUrl}${adfs ? '' : `${tenantId}/`}oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`;
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
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			res.end();
			throw err;
		}
	} finally {
		setTimeout(() => {
			server.close();
		}, 5000);
	}
}


if (require.main === module) {
	login('aebc6443-996d-45c2-90f0-388ff96faa56', Environment.AzureCloud, false, 'common', async uri => console.log(`Open: ${uri}`), async () => console.log('Browser did not connect to local server within 10 seconds.'))
		.catch(console.error);
}
