/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { AccountInfo, AuthenticationResult, Configuration, LogLevel, PublicClientApplication, TokenCache } from "@azure/msal-node";
import { MemoryCache } from "adal-node";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { ExtensionContext } from "vscode";
import { AzureSession } from "../../azure-account.api";
import { clientId, msalScopes } from "../../constants";
import { AzureLoginError } from "../../errors";
import { localize } from "../../utils/localize";
import { ProxyTokenCache } from "../adal/tokens";
import { AbstractCredentials2, AuthProviderBase } from "../AuthProviderBase";
import { cachePlugin } from "./cachePlugin";
import { PublicClientCredential } from "./PublicClientCredential";

export class MsalAuthProvider extends AuthProviderBase<AuthenticationResult> {
	private publicClientApp: PublicClientApplication;

	// For compatibility with `DeviceTokenCredentials`
	private dummyTokenCache: ProxyTokenCache = new ProxyTokenCache(new MemoryCache());

	constructor(context: ExtensionContext, enableVerboseLogs: boolean) {
		super(context);
		const msalConfiguration: Configuration = {
			auth: { clientId },
			cache: { cachePlugin },
			system: {
				loggerOptions: {
					loggerCallback: (_level: LogLevel, message: string, _containsPii: boolean) => {
						this.outputChannel.appendLine(message);
					},
					piiLoggingEnabled: false,
					logLevel: enableVerboseLogs ? LogLevel.Verbose : LogLevel.Error
				}
			}
		};
		this.publicClientApp = new PublicClientApplication(msalConfiguration);
	}

	public async loginWithoutLocalServer(_clientId: string, _environment: Environment, _isAdfs: boolean, _tenantId: string): Promise<AuthenticationResult> {
		throw new Error('"Login Without Local Server" not implemented for MSAL.');
	}

	public async loginWithAuthCode(code: string, redirectUrl: string): Promise<AuthenticationResult> {
		const authResult: AuthenticationResult | null = await this.publicClientApp.acquireTokenByCode({
			scopes: msalScopes,
			code,
			redirectUri: redirectUrl,
		});

		if (!authResult) {
			throw new Error(localize('azure-account.msalAuthFailed', 'MSAL authentication failed.'));
		}

		return authResult;
	}

	public async loginWithDeviceCode(): Promise<AuthenticationResult> {
		throw new Error('"Login With Device Code" not implemented for MSAL.');
	}

	public async loginSilent(): Promise<AuthenticationResult> {
		const msalTokenCache: TokenCache = this.publicClientApp.getTokenCache();
		const accountInfo: AccountInfo[] = await msalTokenCache.getAllAccounts();
		let authResult: AuthenticationResult | null;

		if (accountInfo.length === 1) {
			authResult = await this.publicClientApp.acquireTokenSilent({
				scopes: msalScopes,
				account: accountInfo[0]
			});

			if (!authResult) {
				throw new AzureLoginError(localize('azure-account.loginSilentFailed', 'Silent login failed.'));
			}

			return authResult;
		} else if (accountInfo.length) {
			throw new Error(localize('azure-account.expectedSingleAccount', 'Expected a single account when reading cache but multiple were found.'));
		} else {
			throw new Error(localize('azure-account.noAccountFound', 'No account was found when reading cache.'));
		}
	}

	public getCredentials(environment: string, userId: string, tenantId: string): DeviceTokenCredentials {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
		return new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.dummyTokenCache, domain: tenantId });
	}

	public getCredentials2(_env: Environment, _userId: string, _tenantId: string, accountInfo?: AccountInfo): AbstractCredentials2 {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return new AzureIdentityCredentialAdapter(new PublicClientCredential(this.publicClientApp, accountInfo!));
	}

	public async updateSessions(environment: Environment, loginResult: AuthenticationResult, sessions: AzureSession[]): Promise<void> {
		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		sessions.splice(0, sessions.length, <AzureSession>{
			environment,
			userId: loginResult.account!.username,
			tenantId: loginResult.account!.tenantId,
			accountInfo: loginResult.account!,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			credentials: this.getCredentials(<any>environment, loginResult.account!.username, loginResult.tenantId),
			credentials2: this.getCredentials2(environment, loginResult.account!.username, loginResult.tenantId, loginResult.account!)
		});
		/* eslint-enable @typescript-eslint/no-non-null-assertion */
	}

	public async clearTokenCache(): Promise<void> {
		const tokenCache: TokenCache = this.publicClientApp.getTokenCache();

		for (const account of await tokenCache.getAllAccounts()) {
			await tokenCache.removeAccount(account);
		}
	}
}
