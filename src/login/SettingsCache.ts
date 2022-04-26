/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { authLibrarySetting, cloudSetting, tenantSetting } from "../constants";

// These indices correspond to keys in `cachedSettingKeys` and `values` in `SettingsCache`.
// export const authLibrarySettingIndex: number = 0;
// export const cloudSettingIndex: number = 1;
// export const tenantSettingIndex: number = 2;

export const cachedSettingKeys: string[] = [authLibrarySetting, cloudSetting, tenantSetting];

export const settingsCacheKey: string = 'lastSeenSettingsCache';

export interface SettingsCache {
    values: (string | undefined)[] | undefined;
}

export interface SettingsCacheVerified extends SettingsCache {
    values: (string | undefined)[];
}
