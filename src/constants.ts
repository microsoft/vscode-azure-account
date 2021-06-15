/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";

export const azureCustomCloud: string = 'AzureCustomCloud';
export const azurePPE: string = 'AzurePPE';
export const cacheKey: string = 'cache';
export const clientId: string = 'aebc6443-996d-45c2-90f0-388ff96faa56';
export const commonTenantId: string = 'common';
export const credentialsSection: string = 'VS Code Azure';
export const customCloudArmUrlKey: string = 'azure.customCloud.resourceManagerEndpointUrl';
export const displayName: string = 'Azure Account';

export const staticEnvironments: Environment[] = [
	Environment.AzureCloud,
	Environment.ChinaCloud,
	Environment.GermanCloud,
	Environment.USGovernment
];
