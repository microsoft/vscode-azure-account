/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccessToken, TokenCredential } from "@azure/core-auth";
import { DeviceTokenCredentials } from '@azure/ms-rest-nodeauth';
import { TokenResponse } from "adal-node";

/**
 * Token that is forward compatible with track 2 Azure SDK for Node.js
 * `getToken: Promise<AccessToken>` is required for use with T2 Azure SDK, but doesn't
 * affect T1 SDKs as those require `signRequest`
 * `DeviceTokenCredentials` forces `getToken` to return `TokenResponse` so this is to
 * overwrite that implementation
 */
export class DeviceTokenCredentials2 extends DeviceTokenCredentials implements TokenCredential {
	public async getToken(): Promise<TokenResponse & AccessToken> {
		const tokenResponse = await super.getToken();
		return Object.assign(tokenResponse, <AccessToken>{ 
			token: tokenResponse.accessToken, 
			// We could use `tokenResponse.expiresOn` here but that's a `Date | string` type
			// so it seems more straightforward to do it this way
			expiresOnTimestamp: new Date().getTime() + tokenResponse.expiresIn 
		});
	}

	// I believe we get `signRequest` for free since this class extends `DeviceTokenCredentials`
}
