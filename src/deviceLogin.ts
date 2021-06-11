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

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function deviceLogin(environment: Environment, tenantId: string) {
	const deviceLogin = await deviceLogin1(environment, tenantId);
	const message = showDeviceCodeMessage(deviceLogin);
	const login2 = deviceLogin2(environment, tenantId, deviceLogin);
	return Promise.race([login2, message.then(() => Promise.race([login2, timeout(3 * 60 * 1000)]))]); // 3 minutes
}

async function showDeviceCodeMessage(deviceLogin: UserCodeInfo): Promise<void> {
	const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
	const response = await window.showInformationMessage(deviceLogin.message, copyAndOpen);
	if (response === copyAndOpen) {
		void env.clipboard.writeText(deviceLogin.userCode);
		await openUri(deviceLogin.verificationUrl);
	} else {
		return Promise.reject('user canceled');
	}
}

async function deviceLogin1(environment: Environment, tenantId: string): Promise<UserCodeInfo> {
	return new Promise<UserCodeInfo>((resolve, reject) => {
		const cache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, environment.validateAuthority, cache);
		context.acquireUserCode(environment.activeDirectoryResourceId, clientId, 'en-us', (err, response) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.userCodeFailed', "Acquiring user code failed"), err));
			} else {
				resolve(response);
			}
		});
	});
}

async function deviceLogin2(environment: Environment, tenantId: string, deviceLogin: UserCodeInfo) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, environment.validateAuthority, tokenCache);
		context.acquireTokenWithDeviceCode(`${environment.managementEndpointUrl}`, clientId, deviceLogin, (err, tokenResponse) => {
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
