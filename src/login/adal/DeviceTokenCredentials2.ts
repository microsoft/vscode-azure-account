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
	public async getToken(): Promise<AccessToken & TokenResponse> {
		const tokenResponse = await super.getToken();
		return Object.assign(tokenResponse, {token: tokenResponse.accessToken, expiresOnTimestamp: tokenResponse.expiresIn});
	}
}
