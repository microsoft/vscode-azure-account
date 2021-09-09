/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { AccountInfo } from "@azure/msal-node";
import { randomBytes } from "crypto";
import { ServerResponse } from "http";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { Disposable, env, MessageItem, UIKind, Uri, window } from "vscode";
import { AzureAccountExtensionApi, AzureSession } from "../azure-account.api";
import { redirectUrlAAD, redirectUrlADFS } from "../constants";
import { localize } from "../utils/localize";
import { openUri } from "../utils/openUri";
import { UriEventHandler } from "./adal/login";
import { ISubscriptionCache } from "./AzureLoginHelper";
import { AzureSessionInternal } from "./AzureSessionInternal";
import { getEnvironments } from "./environments";
import { getKey } from "./getKey";
import { CodeResult, createServer, createTerminateServer, RedirectResult, startServer } from './server';

export type AbstractCredentials = DeviceTokenCredentials;
export type AbstractCredentials2 = DeviceTokenCredentials2 | AzureIdentityCredentialAdapter;

export abstract class AuthProviderBase<TLoginResult> {
	private terminateServer: (() => Promise<void>) | undefined;
	private handler: UriEventHandler = new UriEventHandler();

	constructor() {
		window.registerUriHandler(this.handler);
	}

	public abstract loginWithAuthCode(code: string, redirectUrl: string, clientId: string, environment: Environment, tenantId: string): Promise<TLoginResult>;
	public abstract loginWithDeviceCode(environment: Environment, tenantId: string): Promise<TLoginResult>;
	public abstract loginSilent(environment: Environment, tenantId: string, migrateToken?: boolean): Promise<TLoginResult>;
	public abstract getCredentials(environment: string, userId: string, tenantId: string): AbstractCredentials;
	public abstract getCredentials2(environment: Environment, userId: string, tenantId: string, accountInfo?: AccountInfo): AbstractCredentials2;
	public abstract updateSessions(environment: Environment, loginResult: TLoginResult, sessions: AzureSession[]): Promise<void>;
	public abstract clearTokenCache(): Promise<void>;

	public async login(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>): Promise<TLoginResult> {
		if (env.uiKind === UIKind.Web) {
			return await this.loginWithoutLocalServer(clientId, environment, isAdfs, tenantId);
		}

		if (isAdfs && this.terminateServer) {
			await this.terminateServer();
		}

		const nonce: string = randomBytes(16).toString('base64');
		const { server, redirectPromise, codePromise } = createServer(nonce);

		if (isAdfs) {
			this.terminateServer = createTerminateServer(server);
		}

		try {
			const port: number = await startServer(server, isAdfs);
			await openUri(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`);
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);
			const redirectResult: RedirectResult = await redirectPromise;

			if ('err' in redirectResult) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const { err, res } = redirectResult;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				res.end();
				throw err;
			}

			clearTimeout(redirectTimer);

			const host: string = redirectResult.req.headers.host || '';
			const updatedPortStr: string = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
			const updatedPort: number = updatedPortStr ? parseInt(updatedPortStr, 10) : port;
			const state: string = `${updatedPort},${encodeURIComponent(nonce)}`;
			const redirectUrl: string = isAdfs ? redirectUrlADFS : redirectUrlAAD;
			const signInUrl: string = `${environment.activeDirectoryEndpointUrl}${isAdfs ? '' : `${tenantId}/`}oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`;

			redirectResult.res.writeHead(302, { Location: signInUrl })
			redirectResult.res.end();

			const codeResult: CodeResult = await codePromise;
			const serverResponse: ServerResponse = codeResult.res;
			try {
				if ('err' in codeResult) {
					throw codeResult.err;
				}

				try {
					return await this.loginWithAuthCode(codeResult.code, redirectUrl, clientId, environment, tenantId);
				} finally {
					serverResponse.writeHead(302, { Location: '/' });
					serverResponse.end();
				}
			} catch (err) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				serverResponse.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				serverResponse.end();
				throw err;
			}
		} finally {
			setTimeout(() => {
				server.close();
			}, 5000);
		}
	}

	public async loginWithoutLocalServer(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string): Promise<TLoginResult> {
		const callbackUri: Uri = await env.asExternalUri(Uri.parse(`${env.uriScheme}://ms-vscode.azure-account`));
		const nonce: string = randomBytes(16).toString('base64');
		const port: string | number = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
		const callbackEnvironment: string = getCallbackEnvironment(callbackUri);
		const state: string = `${callbackEnvironment}${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
		const signInUrl: string = `${environment.activeDirectoryEndpointUrl}${isAdfs ? '' : `${tenantId}/`}oauth2/authorize`;
		let uri: Uri = Uri.parse(signInUrl);
		uri = uri.with({
			query: `response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${redirectUrlAAD}&state=${state}&resource=${environment.activeDirectoryResourceId}&prompt=select_account`
		});
		void env.openExternal(uri);

		const timeoutPromise = new Promise((_resolve: (value: TLoginResult) => void, reject) => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				reject('Login timed out.');
			}, 1000 * 60 * 5)
		});

		return await Promise.race([this.exchangeCodeForToken(clientId, environment, tenantId, redirectUrlAAD, state), timeoutPromise]);
	}

	public async initializeSessions(cache: ISubscriptionCache, api: AzureAccountExtensionApi): Promise<Record<string, AzureSession>> {
		const sessions: Record<string, AzureSessionInternal> = {};
		const environments: Environment[] = await getEnvironments();

		for (const { session } of cache.subscriptions) {
			const { environment, userId, tenantId, accountInfo } = session;
			const key: string = getKey(environment, userId, tenantId);
			const env: Environment | undefined = environments.find(e => e.name === environment);

			if (!sessions[key] && env) {
				sessions[key] = new AzureSessionInternal(
					env,
					userId,
					tenantId,
					accountInfo,
					this
				);
				api.sessions.push(sessions[key]);
			}
		}

		return sessions;
	}

	private async exchangeCodeForToken(clientId: string, environment: Environment, tenantId: string, callbackUri: string, state: string): Promise<TLoginResult> {
		let uriEventListener: Disposable;
		return new Promise((resolve: (value: TLoginResult) => void , reject) => {
			uriEventListener = this.handler.event(async (uri: Uri) => {
				try {
					/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
					const query = parseQuery(uri);
					const code = query.code;

					// Workaround double encoding issues of state
					if (query.state !== state && decodeURIComponent(query.state) !== state) {
						throw new Error('State does not match.');
					}
					/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

					resolve(await this.loginWithAuthCode(code, callbackUri, clientId, environment, tenantId))
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

	protected async showDeviceCodeMessage(message: string, userCode: string, verificationUrl: string): Promise<void> {
		const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
		const response: MessageItem | undefined = await window.showInformationMessage(message, copyAndOpen);
		if (response === copyAndOpen) {
			void env.clipboard.writeText(userCode);
			await openUri(verificationUrl);
		} else {
			return Promise.reject('user canceled');
		}
	}
}

function getCallbackEnvironment(callbackUri: Uri): string {
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

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
function parseQuery(uri: Uri): any {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString: string[] = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
