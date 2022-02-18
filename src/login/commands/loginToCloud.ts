/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import { QuickPickItem, window, workspace, WorkspaceConfiguration } from "vscode";
import { azureCustomCloud, azurePPE, cloudSetting, commonTenantId, customCloudArmUrlSetting, extensionPrefix, tenantSetting } from "../../constants";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { getEnvironments, getSelectedEnvironment } from "../environments";
import { getCurrentTarget } from "../getCurrentTarget";

const environmentLabels: Record<string, string> = {
	AzureCloud: localize('azure-account.azureCloud', 'Azure'),
	AzureChinaCloud: localize('azure-account.azureChinaCloud', 'Azure China'),
	AzureGermanCloud: localize('azure-account.azureGermanyCloud', 'Azure Germany'),
	AzureUSGovernment: localize('azure-account.azureUSCloud', 'Azure US Government'),
	[azureCustomCloud]: localize('azure-account.azureCustomCloud', 'Azure Custom Cloud'),
	[azurePPE]: localize('azure-account.azurePPE', 'Azure PPE'),
};

export async function loginToCloud(): Promise<void> {
	const current: Environment = await getSelectedEnvironment();
	const selected: QuickPickItem & { environment: Environment } | undefined = await window.showQuickPick<QuickPickItem & { environment: Environment }>(getEnvironments(true /* includePartial */)
		.then(environments => environments.map(environment => ({
			label: environmentLabels[environment.name],
			description: environment.name === current.name ? localize('azure-account.currentCloud', '(Current)') : undefined,
			environment
		}))), {
		placeHolder: localize('azure-account.chooseCloudToLogin', "Choose cloud to sign in to")
	});

	if (selected) {
		const config: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
		if (config.get(cloudSetting) !== selected.environment.name) {
			let armUrl: string | undefined;
			if (selected.environment.name === azureCustomCloud) {
				armUrl = await window.showInputBox({
					prompt: localize('azure-account.enterArmUrl', "Enter the Azure Resource Manager endpoint"),
					placeHolder: 'https://management.local.azurestack.external',
					ignoreFocusOut: true
				});
				if (!armUrl) {
					// directly return when user didn't type in anything or press esc for resourceManagerEndpointUrl inputbox
					return;
				}
			}
			const tenantId: string | undefined = await window.showInputBox({
				prompt: localize('azure-account.enterTenantId', "Enter the tenant id"),
				placeHolder: localize('azure-account.tenantIdPlaceholder', "Enter your tenant id, or '{0}' for the default tenant", commonTenantId),
				ignoreFocusOut: true});
			if (tenantId) {
				if (armUrl) {
					await config.update(customCloudArmUrlSetting, armUrl, getCurrentTarget(config.inspect(customCloudArmUrlSetting)));
				}
				await config.update(tenantSetting, tenantId, getCurrentTarget(config.inspect(tenantSetting)));
				// if outside of normal range, set ppe setting
				await config.update(cloudSetting, selected.environment.name, getCurrentTarget(config.inspect(cloudSetting)));
			} else {
				return;
			}
		}
		return ext.loginHelper.login('loginToCloud');
	}
}
