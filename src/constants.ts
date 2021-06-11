/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { localize } from "./utils/localize";

export const customCloudArmUrlSetting: string = 'customCloud.resourceManagerEndpointUrl';

export const azureCustomCloud: string = 'AzureCustomCloud';
export const azurePPE: string = 'AzurePPE';
export const clientId: string = 'aebc6443-996d-45c2-90f0-388ff96faa56';
export const commonTenantId: string = 'common';
export const credentialsSection: string = 'VS Code Azure';
export const displayName: string = 'Azure Account';
export const enableLogging: boolean = false;

export const staticEnvironments: Environment[] = [
	Environment.AzureCloud,
	Environment.ChinaCloud,
	Environment.GermanCloud,
	Environment.USGovernment
];

export const staticEnvironmentNames: string[] = [
	...staticEnvironments.map(environment => environment.name),
	azureCustomCloud,
	azurePPE
];

export const environmentLabels: Record<string, string> = {
	AzureCloud: localize('azure-account.azureCloud', 'Azure'),
	AzureChinaCloud: localize('azure-account.azureChinaCloud', 'Azure China'),
	AzureGermanCloud: localize('azure-account.azureGermanyCloud', 'Azure Germany'),
	AzureUSGovernment: localize('azure-account.azureUSCloud', 'Azure US Government'),
	[azureCustomCloud]: localize('azure-account.azureCustomCloud', 'Azure Custom Cloud'),
	[azurePPE]: localize('azure-account.azurePPE', 'Azure PPE'),
};
