/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { Logging, MemoryCache, TokenResponse, UserCodeInfo } from "adal-node";
import { DeviceTokenCredentials } from "ms-rest-azure";
import { AzureSession } from "../../azure-account.api";
import { azureCustomCloud, azurePPE, clientId, staticEnvironments } from "../../constants";
import { AzureLoginError } from "../../errors";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { timeout } from "../../utils/timeUtils";
import { AbstractCredentials, AbstractCredentials2, AuthProviderBase } from "../AuthProviderBase";
import { getUserCode } from "./login";
import { addTokenToCache, clearTokenCache, deleteRefreshToken, getStoredCredentials, getTokenResponse, getTokensFromToken, getTokenWithAuthorizationCode, ProxyTokenCache, storeRefreshToken, tokenFromRefreshToken } from "./tokens";

const staticEnvironmentNames: string[] = [
	...staticEnvironments.map(environment => environment.name),
	azureCustomCloud,
	azurePPE
];

export class AdalAuthProvider extends AuthProviderBase<TokenResponse[]> {
	private tokenCache: MemoryCache = new MemoryCache();
	private delayedTokenCache: ProxyTokenCache = new ProxyTokenCache(this.tokenCache);

	constructor(enableVerboseLogs?: boolean) {
		super();
		Logging.setLoggingOptions({
			level: enableVerboseLogs ?
				3 /* Logging.LOGGING_LEVEL.VERBOSE */ :
				0 /* Logging.LOGGING_LEVEL.ERROR */,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			log: (_level: any, message: any, error: any) => {
				if (message) {
					ext.outputChannel.appendLine(message);
				}
				if (error) {
					ext.outputChannel.appendLine(error);
				}
			}
		});
	}

	public async loginWithAuthCode(code: string, redirectUrl: string, clientId: string, environment: Environment, tenantId: string): Promise<TokenResponse[]> {
		const tokenResponse: TokenResponse = await getTokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, code);

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await storeRefreshToken(environment, tokenResponse.refreshToken!);
		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginWithDeviceCode(environment: Environment, tenantId: string): Promise<TokenResponse[]> {
		const userCode: UserCodeInfo = await getUserCode(environment, tenantId);
		const messageTask: Promise<void> = this.showDeviceCodeMessage(userCode.message, userCode.userCode, userCode.verificationUrl);
		const tokenResponseTask: Promise<TokenResponse> = getTokenResponse(environment, tenantId, userCode);
		const tokenResponse: TokenResponse = await Promise.race([tokenResponseTask, messageTask.then(() => Promise.race([tokenResponseTask, timeout(3 * 60 * 1000)]))]); // 3 minutes

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		await storeRefreshToken(environment, tokenResponse.refreshToken!);
		return getTokensFromToken(environment, tenantId, tokenResponse);
	}

	public async loginSilent(environment: Environment, tenantId: string, migrateToken?: boolean): Promise<TokenResponse[]> {
		const storedCreds: string | undefined = await getStoredCredentials(environment, migrateToken);
		if (!storedCreds) {
			throw new AzureLoginError(localize('azure-account.refreshTokenMissing', 'Not signed in'));
		}

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

	public async clearTokenCache(): Promise<void> {
		// 'Azure' and 'AzureChina' are the old names for the 'AzureCloud' and 'AzureChinaCloud' environments
		const allEnvironmentNames: string[] = staticEnvironmentNames.concat(['Azure', 'AzureChina'])
		for (const name of allEnvironmentNames) {
			await deleteRefreshToken(name);
		}

		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedTokenCache.initEnd!();
	}
}
