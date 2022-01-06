/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { resourceFilterSetting } from "../constants";
import { ext } from "../extensionVariables";
import { getSettingValue } from "../utils/settingUtils";
import { getNewFilters } from "./filters";
import { AzureResourceFilterInternal, AzureSubscriptionInternal } from "./subscriptionTypes";

export function updateFilters(configChange = false): void {
	const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
	if (configChange && JSON.stringify(resourceFilter) === ext.loginHelper.oldResourceFilter) {
		return;
	}
	ext.loginHelper.filtersTask = (async () => {
		await ext.loginHelper.api.waitForSubscriptions();
		const subscriptions: AzureSubscriptionInternal[] = await ext.loginHelper.subscriptionsTask;
		ext.loginHelper.oldResourceFilter = JSON.stringify(resourceFilter);
		const newFilters: AzureResourceFilterInternal[] = getNewFilters(subscriptions, resourceFilter);
		ext.loginHelper.api.filters.splice(0, ext.loginHelper.api.filters.length, ...newFilters);
		ext.loginHelper.onFiltersChanged.fire();
		return <AzureResourceFilterInternal[]>ext.loginHelper.api.filters;
	})();
}
