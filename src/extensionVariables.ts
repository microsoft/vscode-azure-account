/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from "vscode";
import { IAzExtOutputChannel, IExperimentationServiceAdapter } from "vscode-azureextensionui";
import { AzureAccountLoginHelper } from "./login/AzureLoginHelper";
import { UriEventHandler } from "./login/exchangeCodeForToken";

export namespace ext {
    export let context: ExtensionContext;
    export let loginHelper: AzureAccountLoginHelper;
    export let outputChannel: IAzExtOutputChannel;
    export let uriEventHandler: UriEventHandler;
    export let experimentationService: IExperimentationServiceAdapter;
    export let isMsalTreatmentVariable: boolean | undefined;
}
