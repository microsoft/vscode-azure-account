//#!/usr/bin/env ts-node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import { Environment } from '@azure/ms-rest-azure-env';
// import { TokenResponse } from 'adal-node';
// import * as crypto from 'crypto';
// import * as vscode from 'vscode';
// import { redirectUrlAAD } from '../constants';
// import { getTokenWithAuthorizationCode } from './adal/tokens';

// class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
// 	public handleUri(uri: vscode.Uri) {
// 		this.fire(uri);
// 	}
// }

// const handler: UriEventHandler = new UriEventHandler();
// vscode.window.registerUriHandler(handler);

// /* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
// function parseQuery(uri: vscode.Uri): any {
// 	return uri.query.split('&').reduce((prev: any, current) => {
// 		const queryString: string[] = current.split('=');
// 		prev[queryString[0]] = queryString[1];
// 		return prev;
// 	}, {});
// }
// /* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

// async function exchangeCodeForToken(clientId: string, environment: Environment, tenantId: string, callbackUri: string, state: string): Promise<TokenResponse> {
// 	let uriEventListener: vscode.Disposable;
// 	return new Promise((resolve: (value: TokenResponse) => void , reject) => {
// 		uriEventListener = handler.event(async (uri: vscode.Uri) => {
// 			try {
// 				/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
// 				const query = parseQuery(uri);
// 				const code = query.code;
	
// 				// Workaround double encoding issues of state
// 				if (query.state !== state && decodeURIComponent(query.state) !== state) {
// 					throw new Error('State does not match.');
// 				}
// 				/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
	
// 				resolve(await getTokenWithAuthorizationCode(clientId, environment, callbackUri, tenantId, code));
// 			} catch (err) {
// 				reject(err);
// 			}
// 		});
// 	}).then(result => {
// 		uriEventListener.dispose()
// 		return result;
// 	}).catch(err => {
// 		uriEventListener.dispose();
// 		throw err;
// 	});
// }

// function getCallbackEnvironment(callbackUri: vscode.Uri): string {
// 	if (callbackUri.authority.endsWith('.workspaces.github.com') || callbackUri.authority.endsWith('.github.dev')) {
// 		return `${callbackUri.authority},`;
// 	}

// 	switch (callbackUri.authority) {
// 		case 'online.visualstudio.com':
// 			return 'vso,';
// 		case 'online-ppe.core.vsengsaas.visualstudio.com':
// 			return 'vsoppe,';
// 		case 'online.dev.core.vsengsaas.visualstudio.com':
// 			return 'vsodev,';
// 		case 'canary.online.visualstudio.com':
// 			return 'vsocanary,';
// 		default:
// 			return '';
// 	}
// }

// async function loginWithoutLocalServer(clientId: string, environment: Environment, adfs: boolean, tenantId: string): Promise<TokenResponse> {
// 	const callbackUri: vscode.Uri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://ms-vscode.azure-account`));
// 	const nonce: string = crypto.randomBytes(16).toString('base64');
// 	const port: string | number = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
// 	const callbackEnvironment: string = getCallbackEnvironment(callbackUri);
// 	const state: string = `${callbackEnvironment}${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
// 	const signInUrl: string = `${environment.activeDirectoryEndpointUrl}${adfs ? '' : `${tenantId}/`}oauth2/authorize`;
// 	let uri: vscode.Uri = vscode.Uri.parse(signInUrl);
// 	uri = uri.with({
// 		query: `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirectUrlAAD}&state=${state}&resource=${environment.activeDirectoryResourceId}&prompt=select_account`
// 	});
// 	void vscode.env.openExternal(uri);

// 	const timeoutPromise = new Promise((_resolve: (value: TokenResponse) => void, reject) => {
// 		const wait = setTimeout(() => {
// 			clearTimeout(wait);
// 			reject('Login timed out.');
// 		}, 1000 * 60 * 5)
// 	});

// 	return Promise.race([exchangeCodeForToken(clientId, environment, tenantId, redirectUrlAAD, state), timeoutPromise]);
// }
