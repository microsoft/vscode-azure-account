/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, commands, MessageItem } from 'vscode';
import { AzureAccount, AzureSession } from './azure-account.api';
import { getUserSettings } from './cloudConsoleLauncher';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as opn from 'opn';

const localize = nls.loadMessageBundle();

export function openCloudConsole(api: AzureAccount) {
	return () => {
		(async () => {
			if (!(await api.waitForLogin())) {
				return commands.executeCommand('azure-account.askForLogin');
			}

			const tokens = await Promise.all(api.sessions.map(session => acquireToken(session)));
			const result = await findUserSettings(tokens);
			if (!result) {
				return requiresSetUp();
			}

			// TODO: How to update the access token when it expires?
			window.createTerminal({
				name: localize('azure-account.cloudConsole', "Cloud Console"),
				shellPath: 'node', // process.argv0, // TODO
				shellArgs: [
					'-e',
					`require('${path.join(__dirname, 'cloudConsoleLauncher')}').main()`,
					result.token.accessToken
				]
			}).show();
		})()
			.catch(console.error);
	};
}

async function findUserSettings(tokens: Token[]) {
	for (const token of tokens) {
		const userSettings = await getUserSettings(token.accessToken);
		if (userSettings && userSettings.storageProfile) {
			return { userSettings, token };
		}
	}
}

async function requiresSetUp() {
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.setUpInPortal', "The first time the Cloud Shell requires set up in the Azure Portal (https://portal.azure.com).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		opn('https://portal.azure.com');
	}
}

interface Token {
	accessToken: string;
	refreshToken: string;
}

async function acquireToken(session: AzureSession) {
	return new Promise<Token>((resolve, reject) => {
		const credentials: any = session.credentials;
		const environment: any = session.environment;
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
			if (err) {
				reject(err);
			} else {
				resolve({
					accessToken: result.accessToken,
					refreshToken: result.refreshToken
				});
			}
		});
	});
}
