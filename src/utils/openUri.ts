/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { env, Uri } from "vscode";

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function openUri(uri: string) {
	await env.openExternal(Uri.parse(uri));
}
