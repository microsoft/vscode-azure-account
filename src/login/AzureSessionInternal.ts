/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { AccountInfo } from '@azure/msal-common';
import { AzureSession } from "../azure-account.api";
import { localize } from '../utils/localize';
import { AbstractCredentials, AbstractCredentials2 } from './AuthProviderBase';

export class AzureSessionInternal implements AzureSession {
	constructor(
		public environment: Environment,
		public userId: string,
		public tenantId: string,
		public accountInfo: AccountInfo | undefined,
		private _credentials: AbstractCredentials | undefined,
		public credentials2: AbstractCredentials2,
	) {}

	public get credentials(): AbstractCredentials {
		if (this._credentials) {
			return this.credentials;
		}
		throw new Error(localize('azure-account.deprecatedCredentials', 'MSAL does not support this credentials type. As a workaround, revert the "azure.authenticationLibrary" setting to "ADAL" and consider filing an issue on the extension author.'));
	}
}
