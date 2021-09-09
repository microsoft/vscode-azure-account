/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { AccountInfo, AuthenticationResult, Configuration, LogLevel, PublicClientApplication, TokenCache } from "@azure/msal-node";
import { randomBytes } from "crypto";
import { Disposable, env, Uri, window } from "vscode";
import { AzureSession } from "../../azure-account.api";
import { clientId, msalScopes, redirectUrlAAD } from "../../constants";
import { AzureLoginError } from "../../errors";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { getCallbackEnvironment, parseQuery, UriEventHandler } from "../adal/login";
import { AbstractCredentials, AbstractCredentials2, AuthProviderBase } from "../AuthProviderBase";
import { AzureSessionInternal } from "../AzureSessionInternal";
import { cachePlugin } from "./cachePlugin";
import { PublicClientCredential } from "./PublicClientCredential";

export class MsalAuthProvider extends AuthProviderBase<AuthenticationResult> {
	private publicClientApp: PublicClientApplication;

	private handler: UriEventHandler = new UriEventHandler();

	constructor(enableVerboseLogs: boolean) {
		super();
		window.registerUriHandler(this.handler);
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

	public async loginWithoutLocalServer(_clientId: string, environment: Environment, isAdfs: boolean, tenantId: string): Promise<AuthenticationResult> {
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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const timeoutPromise = new Promise((_resolve: (value: any) => void, reject) => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				reject('Login timed out.');
			}, 1000 * 60 * 5)
		});

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const result = await Promise.race([this.exchangeCodeForToken(clientId, environment, tenantId, redirectUrlAAD, state), timeoutPromise]);
		console.log(result);

		throw new Error('dummy error');

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		// await storeRefreshToken(environment, tokenResponse.refreshToken!);
		// return getTokensFromToken(environment, tenantId, tokenResponse);
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

	private async exchangeCodeForToken(_clientId: string, _environment: Environment, _tenantId: string, callbackUri: string, state: string) {
		let uriEventListener: Disposable;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new Promise((resolve: (value: any) => void , reject) => {
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

					resolve(await this.loginWithAuthCode(code, callbackUri));
				} catch (err) {
					reject(err);
				}
			});
		}).then(result => {
			uriEventListener.dispose()
			// eslint-disable-next-line @typescript-eslint/no-unsafe-return
			return result;
		}).catch(err => {
			uriEventListener.dispose();
			throw err;
		});
	}
}
