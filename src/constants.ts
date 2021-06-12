/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";

export const azureCustomCloud = 'AzureCustomCloud';
export const azurePPE = 'AzurePPE';
export const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'; // VSC: 'aebc6443-996d-45c2-90f0-388ff96faa56'
export const commonTenantId = 'common';
export const credentialsSection: string = 'VS Code Azure';
export const customCloudArmUrlKey = 'customCloud.resourceManagerEndpointUrl';

export const staticEnvironments: Environment[] = [
	Environment.AzureCloud,
	Environment.ChinaCloud,
	Environment.GermanCloud,
	Environment.USGovernment
];
