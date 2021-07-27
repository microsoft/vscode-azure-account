/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AuthenticationContext, MemoryCache } from "@azure/ms-rest-nodeauth/node_modules/adal-node";
import { UserCodeInfo } from "adal-node";
import { env, MessageItem, window } from "vscode";
import { clientId } from "../constants";
import { AzureLoginError } from "../errors";
import { localize } from "../utils/localize";
import { openUri } from "../utils/openUri";

export async function showDeviceCodeMessage(userCode: UserCodeInfo): Promise<void> {
	const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
	const response: MessageItem | undefined = await window.showInformationMessage(userCode.message, copyAndOpen);
	if (response === copyAndOpen) {
		void env.clipboard.writeText(userCode.userCode);
		await openUri(userCode.verificationUrl);
	} else {
		return Promise.reject('user canceled');
	}
}

export async function getUserCode(environment: Environment, tenantId: string): Promise<UserCodeInfo> {
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
