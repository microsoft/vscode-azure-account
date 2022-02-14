/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccessToken, TokenCredential } from "@azure/core-auth";
import { Constants as MSRestConstants, WebResource } from "@azure/ms-rest-js";
import { AccountInfo, AuthenticationResult, PublicClientApplication } from "@azure/msal-node";
import { AzExtServiceClientCredentials } from "@microsoft/vscode-azext-utils";
import { defaultMsalScopes } from "../../constants";

// Implements `AzExtServiceClientCredentials` for backwards compatibility with dependents that still rely on `signRequest`
export class PublicClientCredential implements TokenCredential, AzExtServiceClientCredentials {
	private publicClientApp: PublicClientApplication;
	private accountInfo: AccountInfo;

	constructor(publicClientApp: PublicClientApplication, accountInfo: AccountInfo) {
		this.publicClientApp = publicClientApp;
		this.accountInfo = accountInfo;
	}

	public async getToken(scopes: string | string[]): Promise<AccessToken | null> {
		scopes = Array.isArray(scopes) ? scopes : [scopes];

		if (scopes.length === 1 && scopes[0] === 'https://management.azure.com/.default') {
			// The Azure Functions & App Service APIs only accept the legacy scope (which is the default scope we use)
			scopes = defaultMsalScopes;
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

	public async signRequest(webResource: WebResource): Promise<WebResource | undefined> {
		const tokenResponse: AccessToken | null = await this.getToken(defaultMsalScopes);
		if (tokenResponse) {
			webResource.headers.set(
				MSRestConstants.HeaderConstants.AUTHORIZATION,
				`${MSRestConstants.HeaderConstants.AUTHORIZATION_SCHEME} ${tokenResponse.token}`
			);
			return webResource;
		}
	}
}
