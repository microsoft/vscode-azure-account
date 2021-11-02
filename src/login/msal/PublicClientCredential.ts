/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccessToken, TokenCredential } from "@azure/core-auth";
import { AccountInfo, AuthenticationResult, PublicClientApplication } from "@azure/msal-node";

export class PublicClientCredential implements TokenCredential {
	private publicClientApp: PublicClientApplication;
	private accountInfo: AccountInfo;

	constructor(publicClientApp: PublicClientApplication, accountInfo: AccountInfo) {
		this.publicClientApp = publicClientApp;
		this.accountInfo = accountInfo;
	}

	public async getToken(scopes: string | string[]): Promise<AccessToken | null> {
		scopes = Array.isArray(scopes) ? scopes : [scopes];

		if (scopes.length === 1 && scopes[0] === 'https://management.azure.com/.default') {
			// The Azure Functions & App Service APIs only accept the legacy scope
			scopes = ['https://management.core.windows.net/.default'];
		}

		const authResult: AuthenticationResult | null = await this.publicClientApp.acquireTokenSilent({
			scopes,
			account: this.accountInfo
		});

		if (authResult && authResult.expiresOn) {
			return {
				token: authResult.accessToken,
				expiresOnTimestamp: authResult.expiresOn.getTime()
			}
		}

		return null;
	}
}
