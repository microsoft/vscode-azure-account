/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { AccountInfo, AuthenticationResult, Configuration, LogLevel, PublicClientApplication, TokenCache } from "@azure/msal-node";
import { AzureSession } from "../../azure-account.api";
import { clientId, msalScopes } from "../../constants";
import { AzureLoginError } from "../../errors";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { AbstractCredentials, AbstractCredentials2, AuthProviderBase } from "../AuthProviderBase";
import { AzureSessionInternal } from "../AzureSessionInternal";
import { cachePlugin } from "./cachePlugin";
import { PublicClientCredential } from "./PublicClientCredential";

export class MsalAuthProvider extends AuthProviderBase<AuthenticationResult> {
	private publicClientApp: PublicClientApplication;

	constructor(enableVerboseLogs: boolean) {
		super();
		const msalConfiguration: Configuration = {
			auth: { clientId },
			cache: { cachePlugin },
			system: {
				loggerOptions: {
					loggerCallback: (_level: LogLevel, message: string, _containsPii: boolean) => {
						ext.outputChannel.appendLine(message);
					},
					piiLoggingEnabled: false,
					logLevel: enableVerboseLogs ? LogLevel.Verbose : LogLevel.Error
				}
			}
		};
		this.publicClientApp = new PublicClientApplication(msalConfiguration);
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

	public getCredentials(): AbstractCredentials {
		throw new Error(localize('azure-account.deprecatedCredentials', 'MSAL does not support this credentials type. As a workaround, revert the "azure.authenticationLibrary" setting to "ADAL" and consider filing an issue on the extension author.'));
	}

	public getCredentials2(_env: Environment, _userId: string, _tenantId: string, accountInfo?: AccountInfo): AbstractCredentials2 {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return new AzureIdentityCredentialAdapter(new PublicClientCredential(this.publicClientApp, accountInfo!));
	}

	public async updateSessions(environment: Environment, loginResult: AuthenticationResult, sessions: AzureSession[]): Promise<void> {
		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		sessions.splice(0, sessions.length, new AzureSessionInternal(
			environment,
			loginResult.account!.username,
			loginResult.account!.tenantId,
			loginResult.account!,
			this
		));
		/* eslint-enable @typescript-eslint/no-non-null-assertion */
	}

	public async clearTokenCache(): Promise<void> {
		const tokenCache: TokenCache = this.publicClientApp.getTokenCache();

		for (const account of await tokenCache.getAllAccounts()) {
			await tokenCache.removeAccount(account);
		}
	}
}
