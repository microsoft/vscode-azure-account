/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, commands, ProgressLocation, Uri } from 'vscode';
import { AzureLoginHelper } from './azure-account';
import { AzureAccount } from './azure-account.api';
import { createReporter } from './telemetry';
import * as opn from 'opn';
import * as nls from 'vscode-nls';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { shells, OSes } from './cloudConsole';
import { activate as activateResourceView } from './resourceView';

const localize = nls.loadMessageBundle();
const enableLogging = false;

export function activate(context: ExtensionContext) {
	const reporter = createReporter(context);
	const azureLogin = new AzureLoginHelper(context, reporter);
	if (enableLogging) {
		logDiagnostics(context, azureLogin.api);
	}
	const subscriptions = context.subscriptions;
	subscriptions.push(createStatusBarItem(azureLogin.api));
	subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
	subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleLinux', () => cloudConsole(azureLogin.api, 'Linux')));
	subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleWindows', () => cloudConsole(azureLogin.api, 'Windows')));
	subscriptions.push(commands.registerCommand('azure-account.uploadFileCloudConsole', uri => uploadFile(azureLogin.api, uri)));
	activateResourceView(context, azureLogin.api);
	return Promise.resolve(azureLogin.api); // Return promise to work around weird error in WinJS.
}

function cloudConsole(api: AzureAccount, os: 'Linux' | 'Windows') {
	const shell = api.createCloudShell(os);
	shell.terminal.then(terminal => terminal.show());
	return shell;
}

function uploadFile(api: AzureAccount, uri?: Uri) {
	(async () => {
		let shell = shells[0];
		if (!shell) {
			const shellName = await window.showInformationMessage(localize('azure-account.uploadingRequiresOpenCloudConsole', "File upload requires an open Cloud Shell."), OSes.Linux.shellName, OSes.Windows.shellName);
			if (!shellName) {
				return;
			}
			shell = cloudConsole(api, shellName === OSes.Linux.shellName ? 'Linux' : 'Windows');
		}
		if (!uri) {
			uri = (await window.showOpenDialog({}) || [])[0];
		}
		if (uri) {
			const filename = basename(uri.fsPath);
			return window.withProgress({
				location: ProgressLocation.Notification,
				title: localize('azure-account.uploading', "Uploading '{0}'...", filename),
				cancellable: true
			}, (progress, token) => {
				return shell.uploadFile(filename, createReadStream(uri!.fsPath), { progress, token });
			});
		}
	})()
		.catch(console.error);
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
				statusBarItem.text = localize('azure-account.loggingIn', "Azure: Signing in...");
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