/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { Logging, MemoryCache, TokenResponse, UserCodeInfo } from "adal-node";
import { randomBytes } from "crypto";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { Disposable, env, ExtensionContext, Uri, window } from "vscode";
import { AzureSession } from "../../azure-account.api";
import { clientId, redirectUrlAAD } from "../../constants";
import { AzureLoginError } from "../../errors";
import { localize } from "../../utils/localize";
import { timeout } from "../../utils/timeUtils";
import { AbstractCredentials, AbstractCredentials2, AuthProviderBase } from "../AuthProviderBase";
import { getCallbackEnvironment, getUserCode, parseQuery, showDeviceCodeMessage, UriEventHandler } from "./login";
import { addTokenToCache, clearTokenCache, getTokenResponse, getTokensFromToken, getTokenWithAuthorizationCode, ProxyTokenCache, storeRefreshToken, tokenFromRefreshToken } from "./tokens";

export class AdalAuthProvider extends AuthProviderBase<TokenResponse[]> {
	private tokenCache: MemoryCache = new MemoryCache();
	private delayedTokenCache: ProxyTokenCache = new ProxyTokenCache(this.tokenCache);

	private handler: UriEventHandler = new UriEventHandler();

	constructor(context: ExtensionContext, enableVerboseLogs: boolean) {
		super(context);
		window.registerUriHandler(this.handler);
		Logging.setLoggingOptions({
			level: enableVerboseLogs ?
				3 /* Logging.LOGGING_LEVEL.VERBOSE */ :
				0 /* Logging.LOGGING_LEVEL.ERROR */,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			log: (_level: any, message: any, error: any) => {
				if (message) {
					this.outputChannel.appendLine(message);
				}
				if (error) {
					this.outputChannel.appendLine(error);
				}
			}
		});
	}

	public async loginWithoutLocalServer(clientId: string, environment: Environment, isAdfs: boolean, tenantId: string): Promise<TokenResponse[]> {
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

		const timeoutPromise = new Promise((_resolve: (value: TokenResponse) => void, reject) => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				reject('Login timed out.');
			}, 1000 * 60 * 5)
		});

		const tokenResponse: TokenResponse = await Promise.race([this.exchangeCodeForToken(clientId, environment, tenantId, redirectUrlAAD, state), timeoutPromise]);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await storeRefreshToken(environment, tokenResponse.refreshToken!);
		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginWithAuthCode(code: string, redirectUrl: string, clientId: string, environment: Environment, tenantId: string): Promise<TokenResponse[]> {
		const tokenResponse: TokenResponse = await getTokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, code);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await storeRefreshToken(environment, tokenResponse.refreshToken!);
		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginWithDeviceCode(environment: Environment, tenantId: string): Promise<TokenResponse[]> {
		const userCode: UserCodeInfo = await getUserCode(environment, tenantId);
		const messageTask: Promise<void> = showDeviceCodeMessage(userCode);
		const tokenResponseTask: Promise<TokenResponse> = getTokenResponse(environment, tenantId, userCode);
		const tokenResponse: TokenResponse = await Promise.race([tokenResponseTask, messageTask.then(() => Promise.race([tokenResponseTask, timeout(3 * 60 * 1000)]))]); // 3 minutes

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await storeRefreshToken(environment, tokenResponse.refreshToken!);
		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginSilent(environment: Environment, storedCreds: string, tenantId: string): Promise<TokenResponse[]> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let parsedCreds: any;
		let tokenResponse: TokenResponse | null = null;

		try {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			parsedCreds = JSON.parse(storedCreds);
		} catch {
			tokenResponse = await tokenFromRefreshToken(environment, storedCreds, tenantId)
		}

		if (parsedCreds) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const { redirectionUrl, code } = parsedCreds;
			if (!redirectionUrl || !code) {
				throw new AzureLoginError(localize('azure-account.malformedCredentials', "Stored credentials are invalid"));
			}

			tokenResponse = await getTokenWithAuthorizationCode(clientId, Environment.AzureCloud, redirectionUrl, tenantId, code);
		}

		if (!tokenResponse) {
			throw new AzureLoginError(localize('azure-account.missingTokenResponse', "Using stored credentials failed"));
		}

		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public getCredentials(environment: string, userId: string, tenantId: string): AbstractCredentials {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
		return new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.delayedTokenCache, domain: tenantId });
	}

	public getCredentials2(environment: Environment, userId: string, tenantId: string): AbstractCredentials2 {
		return new DeviceTokenCredentials2(clientId, tenantId, userId, undefined, environment, this.delayedTokenCache);
	}

	public async updateSessions(environment: Environment, loginResult: TokenResponse[], sessions: AzureSession[]): Promise<void> {
		await clearTokenCache(this.tokenCache);

		for (const tokenResponse of loginResult) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}

		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		this.delayedTokenCache.initEnd!();

		sessions.splice(0, sessions.length, ...loginResult.map<AzureSession>(tokenResponse => ({
			environment,
			userId: tokenResponse.userId!,
			tenantId: tokenResponse.tenantId!,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			credentials: this.getCredentials(<any>environment, tokenResponse.userId!, tokenResponse.tenantId!),
			credentials2: this.getCredentials2(environment, tokenResponse.userId!, tokenResponse.tenantId!)
		})));
		/* eslint-enable @typescript-eslint/no-non-null-assertion */
	}

	public async clearLibraryTokenCache(): Promise<void> {
		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedTokenCache.initEnd!();
	}

	private async exchangeCodeForToken(clientId: string, environment: Environment, tenantId: string, callbackUri: string, state: string): Promise<TokenResponse> {
		let uriEventListener: Disposable;
		return new Promise((resolve: (value: TokenResponse) => void , reject) => {
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

					resolve(await getTokenWithAuthorizationCode(clientId, environment, callbackUri, tenantId, code));
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
}
