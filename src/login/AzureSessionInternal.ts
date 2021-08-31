/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AccountInfo } from "@azure/msal-common";
import { AzureSession } from "../azure-account.api";

export type AzureSessionInternal = AzureSession & { readonly accountInfo?: AccountInfo; };
