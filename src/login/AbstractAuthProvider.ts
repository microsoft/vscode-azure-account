/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { randomBytes } from "crypto";
import { ServerResponse } from "http";
import { env, ExtensionContext, OutputChannel, UIKind, window } from "vscode";
import { AzureAccount, AzureSession } from "../azure-account.api";
import { AuthLibrary, authLibrarySetting, displayName, redirectUrlAAD, redirectUrlADFS } from "../constants";
import { getSettingValue } from "../utils/settingUtils";
import { AbstractLoginResult } from "./AbstractLoginResult";
import { AdalAuthProvider } from "./adal/AdalAuthProvider";
import { ISubscriptionCache } from "./AzureLoginHelper";
import { getEnvironments } from "./environments";
import { getKey } from "./getKey";
import { MsalAuthProvider } from "./msal/MsalAuthProvider";
import { CodeResult, createServer, createTerminateServer, RedirectResult, startServer } from './server';

export class AbstractAuthProvider {
	private adalAuthProvider: AdalAuthProvider;
	private msalAuthProvider: MsalAuthProvider;

	private terminateServer: (() => Promise<void>) | undefined;

	constructor(context: ExtensionContext, enableVerboseLogs: boolean) {
		const outputChannel: OutputChannel = window.createOutputChannel(displayName);
		context.subscriptions.push(outputChannel);
		this.adalAuthProvider = new AdalAuthProvider(outputChannel, enableVerboseLogs);
		this.msalAuthProvider = new MsalAuthProvider(outputChannel, enableVerboseLogs);
	}

	public async login(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>): Promise<AbstractLoginResult> {
		if (env.uiKind === UIKind.Web) {
			// return loginWithoutLocalServer(clientId, environment, adfs, tenantId);
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
	
				const authProvider = this.getAuthProvider();
				try {
					return await authProvider.login(codeResult.code, redirectUrl, clientId, environment, tenantId);
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

	public async loginWithDeviceCode(environment: Environment, tenantId: string): Promise<AbstractLoginResult> {
		const authProvider = this.getAuthProvider();
		return await authProvider.loginWithDeviceCode(environment, tenantId);
	}

	public async loginSilent(environment: Environment, storedCreds: string, tenantId: string): Promise<AbstractLoginResult> {
		const authProvider = this.getAuthProvider();
		return await authProvider.loginSilent(environment, storedCreds, tenantId);
	}

	public async initializeSessions(cache: ISubscriptionCache, api: AzureAccount): Promise<Record<string, AzureSession>> {
		const sessions: Record<string, AzureSession> = {};
		const environments: Environment[] = await getEnvironments();
		const authProvider = this.getAuthProvider();

		for (const { session } of cache.subscriptions) {
			const { environment, userId, tenantId, accountInfo } = session;
			const key: string = getKey(environment, userId, tenantId);
			const env: Environment | undefined = environments.find(e => e.name === environment);

			if (!sessions[key] && env) {
				sessions[key] = {
					environment: env,
					userId,
					tenantId,
					accountInfo,
					credentials: authProvider.getCredentials(environment, userId, tenantId),
					credentials2: authProvider.getCredentials2(env, userId, tenantId, accountInfo)
				};
				api.sessions.push(sessions[key]);
			}
		}

		return sessions;
	}

	public async updateSessions(environment: Environment, loginResult: AbstractLoginResult, sessions: AzureSession[]): Promise<void> {
		const authProvider = this.getAuthProvider();
		await authProvider.updateSessions(environment, loginResult, sessions);
	}

	public async clearTokenCache(): Promise<void> {
		const authProvider = this.getAuthProvider();
		await authProvider.clearTokenCache();
	}

	public async deleteRefreshTokens(): Promise<void> {
		const authProvider = this.getAuthProvider();
		await authProvider.deleteRefreshTokens();
	}

	private getAuthProvider(): AdalAuthProvider | MsalAuthProvider {
		return getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL' ? 
			this.adalAuthProvider : 
			this.msalAuthProvider;
	}
}
