/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from "vscode";
import { IAzExtOutputChannel, IExperimentationServiceAdapter } from "vscode-azureextensionui";

export namespace ext {
    export let context: ExtensionContext;
    export let outputChannel: IAzExtOutputChannel;
    export let experimentationService: IExperimentationServiceAdapter;
}
