/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vscode';
import { ServiceClientCredentials } from 'ms-rest';

export interface AzureLogin {
	readonly account: AzureAccount | undefined;
	readonly onAccountChanged: Event<AzureAccount | undefined>;
}

export interface AzureAccount {
	readonly oid: string;
	readonly userId: string;
	readonly tenantId: string;
	readonly credentials: ServiceClientCredentials;
}