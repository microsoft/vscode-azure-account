/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { callWithTelemetryAndErrorHandlingSync, IActionContext } from "vscode-azureextensionui";
import { AuthLibrary, authLibrarySetting } from "../constants";
import { ext } from "../extensionVariables";
import { getSettingValue } from "../utils/settingUtils";

export function getAuthLibrary(): AuthLibrary {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return (callWithTelemetryAndErrorHandlingSync('getAuthLibrary', (context: IActionContext) => {
		let authLibrary: AuthLibrary | undefined = getSettingValue<AuthLibrary>(authLibrarySetting);

		switch (authLibrary) {
			case 'MSAL':
				context.telemetry.properties.authLibrarySetting = 'MSAL';
				break;
			case 'ADAL':
				context.telemetry.properties.authLibrarySetting = 'ADAL';
				break;
			default:
				context.telemetry.properties.authLibrarySetting = 'undefined';
				if (ext.isMsalTreatmentVariable) {
					authLibrary = 'MSAL';
				} else {
					authLibrary = 'ADAL';
				}
		}

		return authLibrary;
	}))!;
}
