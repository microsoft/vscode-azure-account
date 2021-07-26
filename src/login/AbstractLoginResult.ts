/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AuthenticationResult } from "@azure/msal-node";
import { TokenResponse } from "adal-node";

export type AbstractLoginResult = TokenResponse[] | AuthenticationResult;

export function isAdalLoginResult(loginResult: AbstractLoginResult): boolean {
	return Array.isArray(loginResult);
}
