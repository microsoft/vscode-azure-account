/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccessToken, TokenCredential } from "@azure/core-auth";
import { Constants as MSRestConstants, WebResource } from "@azure/ms-rest-js";
import { DeviceTokenCredentials } from '@azure/ms-rest-nodeauth';

/**
 * Token that is forward compatible with track 2 Azure SDK for Node.js
 * `getToken: Promise<AccessToken>` is required for use with T2 Azure SDK, but doesn't
 * affect T1 SDKs as those require `signRequest`
 * `DeviceTokenCredentials` forces `getToken` to return `TokenResponse` so this is to
 * overwrite that implementation
 */
export class ForwardCompatibleToken extends DeviceTokenCredentials implements TokenCredential {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public async getToken(): Promise<any> {
		const tokenResponse = await this.getTokenFromCache(this.username);
		return <AccessToken>{ token: tokenResponse.accessToken, expiresOnTimestamp: tokenResponse.expiresIn }

	}

    public async signRequest(webResource: WebResource): Promise<WebResource> {
		const tokenResponse: AccessToken = <AccessToken>(await this.getToken());
			webResource.headers.set(
				MSRestConstants.HeaderConstants.AUTHORIZATION,
				`${MSRestConstants.HeaderConstants.AUTHORIZATION_SCHEME} ${tokenResponse.token}`
			);
		return webResource;
	}
}
