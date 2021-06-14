/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, WorkspaceConfiguration } from "vscode";
import { prefix } from "../constants";

export function getSettingWithPrefix(settingName: string): string { 
	return `${prefix}.${settingName}`; 
}

export function getSettingValue<T>(settingName: string): T | undefined {
	const config: WorkspaceConfiguration = workspace.getConfiguration(prefix);
	return config.get(settingName);
}
