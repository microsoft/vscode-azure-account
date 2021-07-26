/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { AccountInfo, AuthenticationResult, Configuration, LogLevel, PublicClientApplication, TokenCache } from "@azure/msal-node";
import { MemoryCache } from "adal-node";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { OutputChannel } from "vscode";
import { AzureSession } from "../../azure-account.api";
import { clientId, scopes } from "../../constants";
import { AzureLoginError } from "../../errors";
import { localize } from "../../utils/localize";
import { AbstractLoginResult, isAdalLoginResult } from "../AbstractLoginResult";
import { ProxyTokenCache } from "../adal/tokens";
import { cachePlugin } from "./cachePlugin";
import { PublicClientCredential } from "./PublicClientCredential";

export class MsalAuthProvider {
	private publicClientApp: PublicClientApplication;

	// For compatibility with `DeviceTokenCredentials`
	private dummyCache: ProxyTokenCache = new ProxyTokenCache(new MemoryCache());

	constructor(outputChannel: OutputChannel, enableVerboseLogs: boolean) {
		const msalConfiguration: Configuration = {
			auth: { clientId },
			cache: { cachePlugin },
			system: {
				loggerOptions: {
					loggerCallback(_loglevel, message, _containsPii) {
						outputChannel.appendLine(message);
					},
					piiLoggingEnabled: false,
					logLevel: enableVerboseLogs ? LogLevel.Verbose : LogLevel.Error
				}
			}
		};

		this.publicClientApp = new PublicClientApplication(msalConfiguration);
	}

	public async login(code: string, redirectUrl: string): Promise<AbstractLoginResult> {
		const authResult: AuthenticationResult | null = await this.publicClientApp.acquireTokenByCode({
			scopes,
			code,
			redirectUri: redirectUrl,
		});

		if (!authResult) {
			throw new Error(localize('azure-account.msalAuthFailed', 'MSAL authentication failed.'));
		}

		return authResult;
	}

	public async loginWithDeviceCode(): Promise<AuthenticationResult> {
		throw new Error('\'Login with Device Code\' not implemented for MSAL.');
	}

	public async loginSilent(): Promise<AbstractLoginResult> {
		const msalTokenCache: TokenCache = this.publicClientApp.getTokenCache();
		const accountInfo: AccountInfo[] = await msalTokenCache.getAllAccounts();
		let authResult: AuthenticationResult | null;

		if (accountInfo.length === 1) {
			authResult = await this.publicClientApp.acquireTokenSilent({
				scopes,
				account: accountInfo[0]
			});
		} else {
			throw new Error(localize('azure-account.expectedSingleAccount', 'Expected a single account when reading cache but multiple were found.'));
		}

		if (!authResult) {
			throw new AzureLoginError(localize('azure-account.loginSilentFailed', 'Silent login failed.'));
		}

		return authResult;
	}

	public getCredentials(environment: string, userId: string, tenantId: string): DeviceTokenCredentials {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
		return new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.dummyCache, domain: tenantId });
	}

	public getCredentials2(_env: Environment, _userId: string, _tenantId: string, accountInfo: AccountInfo | undefined): AzureIdentityCredentialAdapter {
		// TODO: Scopes?
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return new AzureIdentityCredentialAdapter(new PublicClientCredential(this.publicClientApp, accountInfo!));
	}

	public async updateSessions(environment: Environment, loginResult: AbstractLoginResult, sessions: AzureSession[]): Promise<void> {
		if (isAdalLoginResult(loginResult)) {
			throw new Error(localize('azure-account.unexpectedType', 'Unexpected login result type.'));
		}

		loginResult = <AuthenticationResult>loginResult;

		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		sessions.splice(0, sessions.length, <AzureSession>{
			environment,
			userId: loginResult.account!.username,
			tenantId: loginResult.account!.tenantId,
			accountInfo: loginResult.account!,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			credentials: this.getCredentials(<any>environment, loginResult.account!.username, loginResult.tenantId),
			// TODO: Scopes?
			credentials2: this.getCredentials2(environment, loginResult.account!.username, loginResult.tenantId, loginResult.account!)
		});
		/* eslint-enable @typescript-eslint/no-non-null-assertion */
	}

	public async clearTokenCache(): Promise<void> {
		// MSAL handles caching under the hood
		return;
	}

	public async deleteRefreshTokens(): Promise<void> {
		// MSAL handles refresh tokens under the hood
		return;
	}
}
