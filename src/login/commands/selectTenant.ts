/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, window } from "vscode";
import { callWithTelemetryAndErrorHandling, IActionContext } from "vscode-azureextensionui";
import { tenantSetting } from "../../constants";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { openUri } from "../../utils/openUri";
import { updateSettingValue } from "../../utils/settingUtils";
import { AzureResourceFilterInternal } from "../subscriptionTypes";

export async function selectTenant(): Promise<void> {
	await callWithTelemetryAndErrorHandling('azure-account.selectTenant', async (context: IActionContext) => {
		if (!(await ext.loginHelper.api.waitForFilters())) {
			context.telemetry.properties.outcome = 'notLoggedIn';
			return commands.executeCommand('azure-account.askForLogin');
		}

		const tenantSet = new Set<string>();
		for (const filter of ext.loginHelper.api.filters) {
			for (const tenant of (<AzureResourceFilterInternal>filter).tenants) {
				tenantSet.add(tenant);
			}
		}
		const tenants: string[] = Array.from(tenantSet);

		if (!tenants.length) {
			context.telemetry.properties.outcome = 'noTenantsFound';
			const noTenantsFound = localize('azure-account.noTenantsFound', 'No tenants were found for the subscription(s) you\'ve selected.');
			const learnMoreAboutTenants = { title: localize('azure-account.learnMoreAboutTenants', 'Learn more about tenants') };
			void context.ui.showWarningMessage(noTenantsFound, learnMoreAboutTenants).then(result => {
				if (result === learnMoreAboutTenants) {
					void openUri('https://aka.ms/AAfe10l');
				}
			});
		}

		const enterCustomTenant = { label: localize('azure-account.enterCustomTenantWithPencil', '$(pencil) Enter custom tenant') };
		const picks = [...tenants.map(tenant => { return { label: tenant } }), enterCustomTenant];
		const placeHolder = localize('azure-account.selectTenantPlaceHolder', 'Select a tenant. This will update the "azure.tenant" workspace setting.');
		const result = await context.ui.showQuickPick(picks, { placeHolder });
		if (result) {
			let tenant: string;

			if (result === enterCustomTenant) {
				context.telemetry.properties.enterCustomTenant = 'true';
				tenant = await context.ui.showInputBox({ prompt: localize('enterCustomTenant', 'Enter custom tenant') });
			} else {
				tenant = result.label;
			}

			context.telemetry.properties.outcome = 'tenantSelected';
			await updateSettingValue(tenantSetting, tenant);

			const mustSignOut: string = localize('azure-account.mustSignOut', 'You must sign out and sign back in for tenant "{0}" to take effect.', tenant);
			const signOut: string = localize('azure-account.signOut', 'Sign Out');
			void window.showInformationMessage(mustSignOut, signOut).then(async value => {
				if (value === signOut) {
					await ext.loginHelper.logout();
				}
			});
		}
	});
}
