/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, ExtensionContext, commands, ProgressLocation, Uri, workspace, env, ConfigurationTarget } from 'vscode';
import { AzureLoginHelper } from './azure-account';
import { AzureAccount } from './azure-account.api';
import * as nls from 'vscode-nls';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { shells, OSes } from './cloudConsole';
import { survey } from './nps';
import { ext } from './extensionVariables';
import { callWithTelemetryAndErrorHandling, createAzExtOutputChannel, createExperimentationService, IActionContext, registerUIExtensionVariables } from 'vscode-azureextensionui';

const localize = nls.loadMessageBundle();
const enableLogging = false;

export async function activate(context: ExtensionContext) {
	ext.context = context;
	ext.outputChannel = createAzExtOutputChannel('Azure Account', 'azure');
	context.subscriptions.push(ext.outputChannel);

	registerUIExtensionVariables(ext);

	return await callWithTelemetryAndErrorHandling('azure-account.activate', async (activateContext: IActionContext) => {
		activateContext.telemetry.properties.isActivationEvent = 'true';

		await migrateEnvironmentSetting();
		const azureLogin = new AzureLoginHelper(context);
		if (enableLogging) {
			logDiagnostics(context, azureLogin.api);
		}
		const subscriptions = context.subscriptions;
		subscriptions.push(createStatusBarItem(context, azureLogin.api));
		subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
		subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleLinux', () => cloudConsole(azureLogin.api, 'Linux')));
		subscriptions.push(commands.registerCommand('azure-account.openCloudConsoleWindows', () => cloudConsole(azureLogin.api, 'Windows')));
		subscriptions.push(commands.registerCommand('azure-account.uploadFileCloudConsole', uri => uploadFile(azureLogin.api, uri)));
		survey(context);

		ext.experimentationService = await createExperimentationService(context);

		return Promise.resolve(azureLogin.api); // Return promise to work around weird error in WinJS.
	});
}

async function migrateEnvironmentSetting() {
	const configuration = workspace.getConfiguration('azure');
	const CLOUD_SETTING = 'cloud';
	const configInfo = configuration.inspect(CLOUD_SETTING);

	async function migrateSetting(oldValue: string, newValue: string): Promise<void> {
		if (configInfo?.globalValue === oldValue) {
			await configuration.update(CLOUD_SETTING, newValue, ConfigurationTarget.Global);
		}
		if (configInfo?.workspaceValue === oldValue) {
			await configuration.update(CLOUD_SETTING, newValue, ConfigurationTarget.Workspace);
		}
		if (configInfo?.workspaceFolderValue === oldValue) {
			await configuration.update(CLOUD_SETTING, newValue, ConfigurationTarget.WorkspaceFolder);
		}
	}

	await migrateSetting('Azure', 'AzureCloud');
	await migrateSetting('AzureChina', 'AzureChinaCloud');
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
					const azureConfig = workspace.getConfiguration('azure');
					const showSignedInEmail = azureConfig.get<boolean>('showSignedInEmail');
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

export function deactivate() {
}