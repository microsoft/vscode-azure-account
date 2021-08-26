/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ext } from "../extensionVariables";

export function getAbsolutePath(path: string): string {
	return ext.context.asAbsolutePath(path);
}
