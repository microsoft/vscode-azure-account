/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream } from 'fs';
import { basename } from 'path';
import { commands, ConfigurationTarget, env, ExtensionContext, ProgressLocation, Uri, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureLogin } from './azure-account';
import { AzureAccount } from './azure-account.api';
import { OSes, shells } from './cloudConsole';
import { cloudSetting, enableLogging, prefix, showSignedInEmailSetting } from './constants';
import { survey } from './nps';
import { createReporter, TelemetryReporter } from './telemetry';
import { localize } from './utils/localize';

export async function activate(context: ExtensionContext): Promise<AzureAccount> {
	await migrateEnvironmentSetting();
	const reporter: TelemetryReporter = createReporter(context);
	const azureLogin: AzureLogin = new AzureLogin(context, reporter);

	if (enableLogging) {
		logDiagnostics(context, azureLogin.api);
	}

	context.subscriptions.push(createStatusBarItem(context, azureLogin.api));
	context.subscriptions.push(commands.registerCommand('azure-account.login', () => azureLogin.login('login').catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => azureLogin.login('loginWithDeviceCode').catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.logout', () => azureLogin.logout().catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.loginToCloud', () => azureLogin.loginToCloud().catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => azureLogin.askForLogin().catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => azureLogin.selectSubscriptions().catch(console.error)));
	context.subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
	context.subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleLinux', () => cloudConsole(azureLogin.api, 'Linux')));
	context.subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleWindows', () => cloudConsole(azureLogin.api, 'Windows')));
	context.subscriptions.push(commands.registerCommand('azure-account.uploadFileCloudConsole', uri => uploadFile(azureLogin.api, uri)));

	survey(context, reporter);
	return Promise.resolve(azureLogin.api); // Return promise to work around weird error in WinJS.
}

async function migrateEnvironmentSetting() {
	const config: WorkspaceConfiguration = workspace.getConfiguration(prefix);
	const configInfo = config.inspect(cloudSetting);

	async function migrateSetting(oldValue: string, newValue: string): Promise<void> {
		if (configInfo?.globalValue === oldValue) {
			await config.update(cloudSetting, newValue, ConfigurationTarget.Global);
		}
		if (configInfo?.workspaceValue === oldValue) {
			await config.update(cloudSetting, newValue, ConfigurationTarget.Workspace);
		}
		if (configInfo?.workspaceFolderValue === oldValue) {
			await config.update(cloudSetting, newValue, ConfigurationTarget.WorkspaceFolder);
		}
	}

	await migrateSetting('Azure', 'AzureCloud');
	await migrateSetting('AzureChina', 'AzureChinaCloud');
}

function cloudConsole(api: AzureAccount, os: 'Linux' | 'Windows') {
	const shell = api.createCloudShell(os);
	void shell.terminal.then(terminal => terminal.show());
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
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
	return env.openExternal(Uri.parse('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account'));
}

function createStatusBarItem(context: ExtensionContext, api: AzureAccount) {
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
					const azureConfig = workspace.getConfiguration(prefix);
					const showSignedInEmail = azureConfig.get<boolean>(showSignedInEmailSetting);
					statusBarItem.text = showSignedInEmail ? localize('azure-account.loggedIn', "Azure: {0}", api.sessions[0].userId) : localize('azure-account.loggedIn', "Azure: Signed In");
					statusBarItem.show();
				}
				break;
			default:
				statusBarItem.hide();
				break;
		}
	}
	context.subscriptions.push(
		statusBarItem,
		api.onStatusChanged(updateStatusBar),
		api.onSessionsChanged(updateStatusBar),
		workspace.onDidChangeConfiguration(updateStatusBar)
	);
	updateStatusBar();
	return statusBarItem;
}

export function deactivate(): void {
	return;
}