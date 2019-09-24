/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, env, Uri, commands, window } from 'vscode';
import * as codeFlowLogin from './codeFlowLogin';

const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'; // VSC: 'aebc6443-996d-45c2-90f0-388ff96faa56'

export async function activate(context: ExtensionContext) {
	await codeFlowLogin.login(clientId, {} as any, false, 'common', openUri, () => redirectTimeout())
}

async function openUri(uri: string) {
	await env.openExternal(Uri.parse(uri));
}

async function redirectTimeout() {
	const response = await window.showInformationMessage('Browser did not connect to local server within 10 seconds. Do you want to try the alternate sign in using a device code instead?', 'Use Device Code');
	if (response) {
		await commands.executeCommand('azure-account.loginWithDeviceCode');
	}
}
