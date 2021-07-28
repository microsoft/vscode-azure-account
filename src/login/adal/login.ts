/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { AuthenticationContext, MemoryCache } from "@azure/ms-rest-nodeauth/node_modules/adal-node";
import { UserCodeInfo } from "adal-node";
import { env, EventEmitter, MessageItem, Uri, UriHandler, window } from "vscode";
import { clientId } from "../../constants";
import { AzureLoginError } from "../../errors";
import { localize } from "../../utils/localize";
import { openUri } from "../../utils/openUri";

export class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
	public handleUri(uri: Uri): void {
		this.fire(uri);
	}
}

/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
export function parseQuery(uri: Uri): any {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString: string[] = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}
/* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

export function getCallbackEnvironment(callbackUri: Uri): string {
	if (callbackUri.authority.endsWith('.workspaces.github.com') || callbackUri.authority.endsWith('.github.dev')) {
		return `${callbackUri.authority},`;
	}

	switch (callbackUri.authority) {
		case 'online.visualstudio.com':
			return 'vso,';
		case 'online-ppe.core.vsengsaas.visualstudio.com':
			return 'vsoppe,';
		case 'online.dev.core.vsengsaas.visualstudio.com':
			return 'vsodev,';
		case 'canary.online.visualstudio.com':
			return 'vsocanary,';
		default:
			return '';
	}
}

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
