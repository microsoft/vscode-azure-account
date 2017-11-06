/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, commands } from 'vscode';
import { AzureLoginHelper } from './azure-account';
import { AzureAccount } from './azure-account.api';
import * as opn from 'opn';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();
const enableLogging = false;

export function activate(context: ExtensionContext) {
	const azureLogin = new AzureLoginHelper(context);
	if (enableLogging) {
		logDiagnostics(context, azureLogin.api);
	}
	const subscriptions = context.subscriptions;
	subscriptions.push(createStatusBarItem(azureLogin.api));
	subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
	return azureLogin.api;
}

function logDiagnostics(context: ExtensionContext, api: AzureAccount) {
	const subscriptions = context.subscriptions;
	subscriptions.push(api.onStatusChanged(status => {
		console.log(`onStatusChanged: ${status}`);
	}));
	subscriptions.push(api.onSessionsChanged(() => {
		console.log(`onSessionsChanged: ${api.sessions.length} ${api.status}`);
	}));
	(async () => {
		console.log(`waitForLogin: ${await api.waitForLogin()} ${api.status}`);
	})().catch(console.error);
	subscriptions.push(api.onSubscriptionsChanged(() => {
		console.log(`onSubscriptionsChanged: ${api.subscriptions.length}`);
	}));
	(async () => {
		console.log(`waitForSubscriptions: ${await api.waitForSubscriptions()} ${api.subscriptions.length}`);
	})().catch(console.error);
	subscriptions.push(api.onFiltersChanged(() => {
		console.log(`onFiltersChanged: ${api.filters.length}`);
	}));
	(async () => {
		console.log(`waitForFilters: ${await api.waitForFilters()} ${api.filters.length}`);
	})().catch(console.error);
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

export function deactivate() {
}