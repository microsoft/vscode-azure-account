/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";

export type AuthLibrary = 'ADAL' | 'MSAL';

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
export const clientId: string = 'x';
export const commonTenantId: string = 'common';
export const displayName: string = 'Azure Account';
export const redirectUrlAAD: string = 'https://vscode-redirect.azurewebsites.net/';
export const portADFS: number = 19472;
export const redirectUrlADFS: string = `http://127.0.0.1:${portADFS}/callback`;

export const defaultMsalScopes: string[] = ['https://management.core.windows.net/.default'];

export const staticEnvironments: Environment[] = [
	Environment.AzureCloud,
	Environment.ChinaCloud,
	Environment.GermanCloud,
	Environment.USGovernment
];
