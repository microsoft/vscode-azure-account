/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseError } from "vscode-azureextensionui";
import { ext } from "../extensionVariables";

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function logErrorMessage(error: any): void {
	ext.outputChannel.appendLog(parseError(error).message);
}
