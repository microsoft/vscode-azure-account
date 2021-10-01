/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IExperimentationServiceAdapter } from "vscode-azureextensionui";

export namespace ext {
    export let experimentationService: IExperimentationServiceAdapter;
}
