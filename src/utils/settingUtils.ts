/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, WorkspaceConfiguration } from "vscode";
import { extensionPrefix } from "../constants";

export function getSettingWithPrefix(settingName: string): string { 
	return `${extensionPrefix}.${settingName}`; 
}

export function getSettingValue<T>(settingName: string): T | undefined {
	const config: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
	return config.get(settingName);
}
