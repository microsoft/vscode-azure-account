/*---------------------------------------------------------------------------------------------
*  Copyright (c) Microsoft Corporation. All rights reserved.
*  Licensed under the MIT License. See License.txt in the project root for license information.
*--------------------------------------------------------------------------------------------*/

import { bootstrap } from "global-agent";
import { workspace } from "vscode";

export async function configureGlobalAgent(): Promise<void> {

    workspace.getConfiguration('http.proxy')

    // lowercase environment variables take precedence over uppercase ones
    process.env.GLOBAL_AGENT_HTTPS_PROXY = workspace.getConfiguration('http').get('proxy') || process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    process.env.GLOBAL_AGENT_HTTP_PROXY = workspace.getConfiguration('http').get('proxy') || process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    process.env.GLOBAL_AGENT_NO_PROXY = process.env.no_proxy ?? process.env.NO_PROXY;
    bootstrap();
}