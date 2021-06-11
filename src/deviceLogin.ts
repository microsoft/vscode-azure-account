/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AuthenticationContext, MemoryCache, TokenResponse, UserCodeInfo } from "adal-node";
import { env, MessageItem, window } from "vscode";
import { clientId } from "./constants";
import { AzureLoginError } from "./errors";
import { localize } from "./utils/localize";
import { openUri } from "./utils/openUri";
import { timeout } from "./utils/timeUtils";

export async function loginWithDeviceCode(environment: Environment, tenantId: string): Promise<TokenResponse> {
	const userCode: UserCodeInfo = await getUserCode(environment, tenantId);
	const messageTask: Promise<void> = showDeviceCodeMessage(userCode);
	const tokenResponseTask: Promise<TokenResponse> = getTokenResponse(environment, tenantId, userCode);
	return Promise.race([tokenResponseTask, messageTask.then(() => Promise.race([tokenResponseTask, timeout(3 * 60 * 1000)]))]); // 3 minutes
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
