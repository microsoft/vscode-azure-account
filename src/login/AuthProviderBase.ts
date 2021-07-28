/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { TokenResponse } from "adal-node";
import { randomBytes } from "crypto";
import { ServerResponse } from "http";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { env, ExtensionContext, OutputChannel, UIKind, window } from "vscode";
import { AzureAccount, AzureSession } from "../azure-account.api";
import { displayName, redirectUrlAAD, redirectUrlADFS } from "../constants";
import { ISubscriptionCache } from "./AzureLoginHelper";
import { getEnvironments } from "./environments";
import { getKey } from "./getKey";
import { CodeResult, createServer, createTerminateServer, RedirectResult, startServer } from './server';

export type AbstractLoginResult = TokenResponse[];
export type AbstractCredentials = DeviceTokenCredentials;
export type AbstractCredentials2 = DeviceTokenCredentials2;

export abstract class AuthProviderBase {
	private terminateServer: (() => Promise<void>) | undefined;

	protected outputChannel: OutputChannel;

	constructor(context: ExtensionContext) {
		this.outputChannel = window.createOutputChannel(displayName);
		context.subscriptions.push(this.outputChannel);
	}

	public abstract loginWithoutLocalServer(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string): Promise<AbstractLoginResult>;
	public abstract loginWithAuthCode(code: string, redirectUrl: string, clientId: string, environment: Environment, tenantId: string): Promise<AbstractLoginResult>;
	public abstract loginWithDeviceCode(environment: Environment, tenantId: string): Promise<AbstractLoginResult>;
	public abstract loginSilent(environment: Environment, storedCreds: string, tenantId: string): Promise<AbstractLoginResult>;
	public abstract getCredentials(environment: string, userId: string, tenantId: string): AbstractCredentials;
	public abstract getCredentials2(environment: Environment, userId: string, tenantId: string): AbstractCredentials2;
	public abstract updateSessions(environment: Environment, loginResult: AbstractLoginResult, sessions: AzureSession[]): Promise<void>;
	public abstract clearTokenCache(): Promise<void>;
	public abstract deleteRefreshTokens(): Promise<void>;

	public async login(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string, openUri: (url: string) => Promise<void>, redirectTimeout: () => Promise<void>): Promise<AbstractLoginResult> {
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

	public async initializeSessions(cache: ISubscriptionCache, api: AzureAccount): Promise<Record<string, AzureSession>> {
		const sessions: Record<string, AzureSession> = {};
		const environments: Environment[] = await getEnvironments();

		for (const { session } of cache.subscriptions) {
			const { environment, userId, tenantId } = session;
			const key: string = getKey(environment, userId, tenantId);
			const env: Environment | undefined = environments.find(e => e.name === environment);

			if (!sessions[key] && env) {
				sessions[key] = {
					environment: env,
					userId,
					tenantId,
					credentials: this.getCredentials(environment, userId, tenantId),
					credentials2: this.getCredentials2(env, userId, tenantId)
				};
				api.sessions.push(sessions[key]);
			}
		}

		return sessions;
	}
}
