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

export enum OS {
	Linux = 'linux',
	Windows = 'windows'
};

export function openCloudConsole(api: AzureAccount, os: OS) {
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
			const isWindows = process.platform === 'win32';
			const shellPath = isWindows ? 'node.exe' : 'node';
			let modulePath = path.join(__dirname, 'cloudConsoleLauncher');
			if (isWindows) {
				modulePath = modulePath.replace(/\\/g, '\\\\');
			}
			window.createTerminal({
				name: localize('azure-account.cloudConsole', "Cloud Shell"),
				shellPath, // process.argv0, // TODO
				shellArgs: [
					'-e',
					`require('${modulePath}').main()`,
				],
				env: {
					CLOUD_CONSOLE_ACCESS_TOKEN: result.token.accessToken,
					ARM_ENDPOINT: result.token.session.environment.resourceManagerEndpointUrl,
					CLOUD_CONSOLE_OS_TYPE: os
				}
			}).show();
		})()
			.catch(console.error);
	};
}

async function findUserSettings(tokens: Token[]) {
	for (const token of tokens) {
		const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
		if (userSettings && userSettings.storageProfile) {
			return { userSettings, token };
		}
	}
}

async function requiresSetUp() {
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.setUpInPortal', "First launch of Cloud Shell requires setup in the Azure portal (https://portal.azure.com).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		opn('https://portal.azure.com');
	}
}

interface Token {
	session: AzureSession;
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
					session,
					accessToken: result.accessToken,
					refreshToken: result.refreshToken
				});
			}
		});
	});
}
