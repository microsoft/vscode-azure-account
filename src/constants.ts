/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";

export type AuthLibrary = 'ADAL' | 'MSAL (Preview)';

export const extensionPrefix: string = 'azure';
export const authLibrarySetting: string = 'authenticationLibrary';
export const cloudSetting: string = 'cloud';
export const customCloudArmUrlSetting: string = 'customCloud.resourceManagerEndpointUrl';
export const ppeSetting: string = 'ppe';
export const resourceFilterSetting: string = 'resourceFilter';
export const showSignedInEmailSetting: string = 'showSignedInEmail';
export const tenantSetting: string = 'tenant';

export const azureCustomCloud: string = 'AzureCustomCloud';
export const azurePPE: string = 'AzurePPE';
export const cacheKey: string = 'cache';
export const clientId: string = 'aebc6443-996d-45c2-90f0-388ff96faa56';
export const commonTenantId: string = 'common';
export const credentialsSection: string = 'VS Code Azure';
export const displayName: string = 'Azure Account';
export const redirectUrlAAD: string = 'https://vscode-redirect.azurewebsites.net/';
export const portADFS: number = 19472;
export const redirectUrlADFS: string = `http://127.0.0.1:${portADFS}/callback`;

export const msalScopes: string[] = ['user.read'];

export const staticEnvironments: Environment[] = [
	Environment.AzureCloud,
	Environment.ChinaCloud,
	Environment.GermanCloud,
	Environment.USGovernment
];
