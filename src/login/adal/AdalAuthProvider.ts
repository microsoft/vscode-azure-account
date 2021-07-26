/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { AuthenticationContext, Logging, MemoryCache, TokenResponse, UserCodeInfo } from "adal-node";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { env, MessageItem, OutputChannel, window } from "vscode";
import { AzureSession } from "../../azure-account.api";
import { azureCustomCloud, azurePPE, clientId, commonTenantId, staticEnvironments } from "../../constants";
import { AzureLoginError } from "../../errors";
import { localize } from "../../utils/localize";
import { openUri } from "../../utils/openUri";
import { timeout } from "../../utils/timeUtils";
import { AbstractLoginResult, isAdalLoginResult } from "../AbstractLoginResult";
import { addTokenToCache, clearTokenCache, deleteRefreshToken, getTokenWithAuthorizationCode, ProxyTokenCache, storeRefreshToken, tokenFromRefreshToken, tokensFromToken } from "./tokens";

const staticEnvironmentNames: string[] = [
	...staticEnvironments.map(environment => environment.name),
	azureCustomCloud,
	azurePPE
];

export class AdalAuthProvider {
	private tokenCache: MemoryCache = new MemoryCache();
	private delayedTokenCache: ProxyTokenCache = new ProxyTokenCache(this.tokenCache);

	constructor(outputChannel: OutputChannel, enableVerboseLogs: boolean) {
		Logging.setLoggingOptions({
			level: enableVerboseLogs ? 
				3 /* Logging.LOGGING_LEVEL.VERBOSE */ : 
				0 /* Logging.LOGGING_LEVEL.ERROR */,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			log: (_level: any, message: any, error: any) => {
				if (message) {
					outputChannel.appendLine(message);
				}
				if (error) {
					outputChannel.appendLine(error);
				}
			}
		});
	}

	public async login(code: string, redirectUrl: string, clientId: string, environment: Environment, tenantId: string): Promise<AbstractLoginResult> {
		const tokenResponse: TokenResponse = await getTokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, code);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const refreshToken: string = tokenResponse.refreshToken!;
		await storeRefreshToken(environment, refreshToken);

		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginWithDeviceCode(environment: Environment, tenantId: string): Promise<TokenResponse[]> {
		const userCode: UserCodeInfo = await getUserCode(environment, tenantId);
		const messageTask: Promise<void> = showDeviceCodeMessage(userCode);
		const tokenResponseTask: Promise<TokenResponse> = getTokenResponse(environment, tenantId, userCode);
		const tokenResponse: TokenResponse = await Promise.race([tokenResponseTask, messageTask.then(() => Promise.race([tokenResponseTask, timeout(3 * 60 * 1000)]))]); // 3 minutes

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		const refreshToken: string = tokenResponse.refreshToken!;
		await storeRefreshToken(environment, refreshToken);

		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginSilent(environment: Environment, storedCreds: string, tenantId: string): Promise<AbstractLoginResult> {
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

	public getCredentials(environment: string, userId: string, tenantId: string): DeviceTokenCredentials {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
		return new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.delayedTokenCache, domain: tenantId });
	}

	public getCredentials2(env: Environment, userId: string, tenantId: string): DeviceTokenCredentials2 {
		return new DeviceTokenCredentials2(clientId, tenantId, userId, undefined, env, this.delayedTokenCache);
	}

	public async updateSessions(environment: Environment, loginResult: AbstractLoginResult, sessions: AzureSession[]): Promise<void> {
		await clearTokenCache(this.tokenCache);

		if (!isAdalLoginResult(loginResult)) {
			throw new Error(localize('azure-account.unexpectedType', 'Unexpected login result type.'));
		}

		loginResult = <TokenResponse[]>loginResult;

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

	public async clearTokenCache(): Promise<void> {
		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedTokenCache.initEnd!();
	}

	public async deleteRefreshTokens(): Promise<void> {
		// 'Azure' and 'AzureChina' are the old names for the 'AzureCloud' and 'AzureChinaCloud' environments
		const allEnvironmentNames: string[] = staticEnvironmentNames.concat(['Azure', 'AzureChina', 'AzurePPE'])
		for (const name of allEnvironmentNames) {
			await deleteRefreshToken(name);
		}
	}
}

async function getTokensFromToken(environment: Environment, tenantId: string, tokenResponse: TokenResponse): Promise<TokenResponse[]> {
	return tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
}

async function showDeviceCodeMessage(userCode: UserCodeInfo): Promise<void> {
	const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
	const response: MessageItem | undefined = await window.showInformationMessage(userCode.message, copyAndOpen);
	if (response === copyAndOpen) {
		void env.clipboard.writeText(userCode.userCode);
		await openUri(userCode.verificationUrl);
	} else {
		return Promise.reject('user canceled');
	}
}

async function getUserCode(environment: Environment, tenantId: string): Promise<UserCodeInfo> {
	return new Promise<UserCodeInfo>((resolve, reject) => {
		const cache: MemoryCache = new MemoryCache();
		const context: AuthenticationContext = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, environment.validateAuthority, cache);
		context.acquireUserCode(environment.activeDirectoryResourceId, clientId, 'en-us', (err, response) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.userCodeFailed', "Acquiring user code failed"), err));
			} else {
				resolve(response);
			}
		});
	});
}

async function getTokenResponse(environment: Environment, tenantId: string, userCode: UserCodeInfo): Promise<TokenResponse> {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache: MemoryCache = new MemoryCache();
		const context: AuthenticationContext = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, environment.validateAuthority, tokenCache);
		context.acquireTokenWithDeviceCode(`${environment.managementEndpointUrl}`, clientId, userCode, (err, tokenResponse) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), err));
			} else if (tokenResponse.error) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), tokenResponse));
			} else {
				resolve(<TokenResponse>tokenResponse);
			}
		});
	});
}