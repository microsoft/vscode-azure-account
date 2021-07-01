/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccessToken, TokenCredential } from "@azure/identity";
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
