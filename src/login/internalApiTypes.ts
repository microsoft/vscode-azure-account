/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccountInfo } from "@azure/msal-common";
import { ServiceClientCredentials } from 'ms-rest';
import { AzureAccount, AzureSession } from "../azure-account.api";

export type AzureAccountInternal = AzureAccount & {
	readonly isLegacyApi: boolean;
}

export type AzureSessionInternal = AzureSession & {
	readonly accountInfo?: AccountInfo;
	readonly credentials?: ServiceClientCredentials;
};
