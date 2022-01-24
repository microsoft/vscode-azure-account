/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window } from "vscode";
import { IActionContext } from "vscode-azureextensionui";
import { tenantSetting } from "../../constants";
import { ext } from "../../extensionVariables";
import { localize } from "../../utils/localize";
import { updateSettingValue } from "../../utils/settingUtils";
import { TenantIdDescription } from "../TenantIdDescription";

export async function selectTenant(context: IActionContext): Promise<void> {
	const tenants: TenantIdDescription[] = await ext.loginHelper.tenantsTask;
	const enterCustomTenant = { label: localize('azure-account.enterCustomTenantWithPencil', '$(pencil) Enter custom tenant') };
	const picks = [
		...tenants.map(tenant => {
			return {
				label: tenant.tenantId,
				description: tenant.displayName
			}
		}),
		enterCustomTenant
	];
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

		if (ext.loginHelper.api.status === 'LoggedIn') {
			const mustSignOut: string = localize('azure-account.mustSignOut', 'You must sign out and sign back in for tenant "{0}" to take effect.', tenant);
			const signOut: string = localize('azure-account.signOut', 'Sign Out');
			void window.showInformationMessage(mustSignOut, signOut).then(async value => {
				if (value === signOut) {
					await ext.loginHelper.logout();
				}
			});
		}
	}
}
