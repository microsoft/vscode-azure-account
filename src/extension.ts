/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, commands } from 'vscode';
import { AzureLoginHelper } from './azure-account';
import { AzureAccount, AzureSession } from './azure-account.api';
import * as opn from 'opn';
import * as nls from 'vscode-nls';
import * as path from 'path';

const localize = nls.loadMessageBundle();

export function activate(context: ExtensionContext) {
	const azureLogin = new AzureLoginHelper(context);
	const subscriptions = context.subscriptions;
	subscriptions.push(createStatusBarItem(azureLogin.api));
	subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
	subscriptions.push(commands.registerCommand('azure-account.openCloudConsole', openCloudConsole(azureLogin.api)));
	return azureLogin.api;
}

function createAccount() {
	opn('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account');
}

function createStatusBarItem(api: AzureAccount) {
	const statusBarItem = window.createStatusBarItem();
	statusBarItem.command = "azure-account.selectSubscriptions";
	function updateStatusBar() {
		switch (api.status) {
			case 'LoggingIn':
				statusBarItem.text = localize('azure-account.loggingIn', "Azure: Logging in...");
				statusBarItem.show();
				break;
			case 'LoggedIn':
				if (api.sessions.length) {
					statusBarItem.text = localize('azure-account.loggedIn', "Azure: {0}", api.sessions[0].userId);
					statusBarItem.show();
				}
				break;
			default:
				statusBarItem.hide();
				break;
		}
	}
	api.onStatusChanged(updateStatusBar);
	api.onSessionsChanged(updateStatusBar);
	updateStatusBar();
	return statusBarItem;
}

function openCloudConsole(api: AzureAccount) {
	return () => {
		(async () => {
			if (!(await api.waitForLogin())) {
				return commands.executeCommand('azure-account.askForLogin');
			}

			const tokens = await Promise.all(api.sessions.map(session => acquireToken(session))); // TODO: How to update the access token when it expires?
			window.createTerminal({
				name: localize('azure-account.cloudConsole', "Cloud Console"),
				shellPath: 'node', // process.argv0, // TODO
				shellArgs: [
					path.join(__dirname, 'cloudConsoleLauncher.js'),
					...tokens.map(token => token.accessToken)
				]
			}).show();
		})()
			.catch(console.error);
	};
}

async function acquireToken(session: AzureSession) {
	return new Promise<{ accessToken: string; refreshToken: string; }>((resolve, reject) => {
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
export function deactivate() {
}