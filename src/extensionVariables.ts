/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from "vscode";
import { IAzExtOutputChannel, IExperimentationServiceAdapter } from "vscode-azureextensionui";
import { AdalAuthProvider } from "./login/adal/AdalAuthProvider";
import { UriEventHandler } from "./login/exchangeCodeForToken";
import { MsalAuthProvider } from "./login/msal/MsalAuthProvider";

export namespace ext {
    export let context: ExtensionContext;
    export let outputChannel: IAzExtOutputChannel;
    export let uriEventHandler: UriEventHandler;
    export let experimentationService: IExperimentationServiceAdapter;
    export let authProvider: AdalAuthProvider | MsalAuthProvider;
}
