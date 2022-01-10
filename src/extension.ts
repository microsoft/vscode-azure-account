/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream } from 'fs';
import { basename } from 'path';
import { CancellationToken, commands, ConfigurationTarget, env, ExtensionContext, ProgressLocation, Uri, window, workspace, WorkspaceConfiguration } from 'vscode';
import { callWithTelemetryAndErrorHandling, createApiProvider, createAzExtOutputChannel, createExperimentationService, IActionContext, registerReportIssueCommand, registerUIExtensionVariables } from 'vscode-azureextensionui';
import { AzureExtensionApiProvider } from 'vscode-azureextensionui/api';
import { AzureAccountExtensionApi } from './azure-account.api';
import { createCloudConsole, OSes, OSName, shells } from './cloudConsole/cloudConsole';
import { cloudSetting, displayName, extensionPrefix, showSignedInEmailSetting } from './constants';
import { ext } from './extensionVariables';
import { AzureAccountLoginHelper } from './login/AzureLoginHelper';
import { askForLogin } from './login/commands/askForLogin';
import { loginToCloud } from './login/commands/loginToCloud';
import { selectSubscriptions } from './login/commands/selectSubscriptions';
import { selectTenant } from './login/commands/selectTenant';
import { UriEventHandler } from './login/exchangeCodeForToken';
import { updateFilters } from './login/updateFilters';
import { updateSubscriptionsAndTenants } from './login/updateSubscriptions';
import { survey } from './nps';
import { localize } from './utils/localize';
import { logErrorMessage } from './utils/logErrorMessage';
import { getSettingValue } from './utils/settingUtils';

const enableLogging: boolean = false;

export async function activateInternal(context: ExtensionContext, perfStats: { loadStartTime: number; loadEndTime: number }): Promise<AzureExtensionApiProvider> {
	ext.context = context;
	ext.outputChannel = createAzExtOutputChannel(displayName, extensionPrefix);
	ext.uriEventHandler = new UriEventHandler();
	context.subscriptions.push(ext.outputChannel);
	context.subscriptions.push(window.registerUriHandler(ext.uriEventHandler));
	registerUIExtensionVariables(ext);

	await callWithTelemetryAndErrorHandling('azure-account.activate', async (activateContext: IActionContext) => {
		activateContext.telemetry.properties.isActivationEvent = 'true';
		activateContext.telemetry.properties.activationTime = String((perfStats.loadEndTime - perfStats.loadStartTime) / 1000);

		ext.experimentationService = await createExperimentationService(context);
		ext.isMsalTreatmentVariable = await ext.experimentationService.getCachedTreatmentVariable('azure-account.isMsal');
		ext.loginHelper = new AzureAccountLoginHelper(context);

		await migrateEnvironmentSetting();
		if (enableLogging) {
			logDiagnostics(context, ext.loginHelper.api);
		}
		context.subscriptions.push(createStatusBarItem(context, ext.loginHelper.api));
		context.subscriptions.push(commands.registerCommand('azure-account.loginToCloud', loginToCloud));
		context.subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', selectSubscriptions));
		context.subscriptions.push(commands.registerCommand('azure-account.selectTenant', selectTenant));
		context.subscriptions.push(commands.registerCommand('azure-account.askForLogin', askForLogin));
		context.subscriptions.push(commands.registerCommand('azure-account.createAccount', createAccount));
		context.subscriptions.push(commands.registerCommand('azure-account.uploadFileCloudConsole', uri => uploadFile(ext.loginHelper.api, uri)));
		context.subscriptions.push(ext.loginHelper.api.onSessionsChanged(updateSubscriptionsAndTenants));
		context.subscriptions.push(ext.loginHelper.api.onSubscriptionsChanged(() => updateFilters()));
		registerReportIssueCommand('azure-account.reportIssue');

		context.subscriptions.push(window.registerTerminalProfileProvider('azure-account.cloudShellBash', {
			provideTerminalProfile: (token: CancellationToken) => {
				return createCloudConsole(ext.loginHelper.api, 'Linux', token).terminalProfile;
			}
		}));
		context.subscriptions.push(window.registerTerminalProfileProvider('azure-account.cloudShellPowerShell', {
			provideTerminalProfile: (token: CancellationToken) => {
				return createCloudConsole(ext.loginHelper.api, 'Windows', token).terminalProfile;
			}
		}));

		await survey(context);
	});

	return Object.assign(ext.loginHelper.legacyApi, createApiProvider([ext.loginHelper.api]));
}

async function migrateEnvironmentSetting() {
	const configuration: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
	const configInfo = configuration.inspect(cloudSetting);

	async function migrateSetting(oldValue: string, newValue: string): Promise<void> {
		if (configInfo?.globalValue === oldValue) {
			await configuration.update(cloudSetting, newValue, ConfigurationTarget.Global);
		}
		if (configInfo?.workspaceValue === oldValue) {
			await configuration.update(cloudSetting, newValue, ConfigurationTarget.Workspace);
		}
		if (configInfo?.workspaceFolderValue === oldValue) {
			await configuration.update(cloudSetting, newValue, ConfigurationTarget.WorkspaceFolder);
		}
	}

	await migrateSetting('Azure', 'AzureCloud');
	await migrateSetting('AzureChina', 'AzureChinaCloud');
}

function cloudConsole(api: AzureAccountExtensionApi, os: OSName) {
	const shell = api.createCloudShell(os);
	if (shell) {
		void shell.terminal.then(terminal => terminal.show());
		return shell;
	}
}

function uploadFile(api: AzureAccountExtensionApi, uri?: Uri) {
	(async () => {
		let shell = shells[0];
		if (!shell) {
			const shellName = await window.showInformationMessage(localize('azure-account.uploadingRequiresOpenCloudConsole', "File upload requires an open Cloud Shell."), OSes.Linux.shellName, OSes.Windows.shellName);
			if (!shellName) {
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			shell = cloudConsole(api, shellName === OSes.Linux.shellName ? 'Linux' : 'Windows')!;
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
		.catch(logErrorMessage);
}

function logDiagnostics(context: ExtensionContext, api: AzureAccountExtensionApi) {
	const subscriptions = context.subscriptions;
	subscriptions.push(api.onStatusChanged(status => {
		ext.outputChannel.appendLog(`onStatusChanged: ${status}`);
	}));
	subscriptions.push(api.onSessionsChanged(() => {
		ext.outputChannel.appendLog(`onSessionsChanged: ${api.sessions.length} ${api.status}`);
	}));
	(async () => {
		ext.outputChannel.appendLog(`waitForLogin: ${await api.waitForLogin()} ${api.status}`);
	})().catch(logErrorMessage);
	subscriptions.push(api.onSubscriptionsChanged(() => {
		ext.outputChannel.appendLog(`onSubscriptionsChanged: ${api.subscriptions.length}`);
	}));
	(async () => {
		ext.outputChannel.appendLog(`waitForSubscriptions: ${await api.waitForSubscriptions()} ${api.subscriptions.length}`);
	})().catch(logErrorMessage);
	subscriptions.push(api.onFiltersChanged(() => {
		ext.outputChannel.appendLog(`onFiltersChanged: ${api.filters.length}`);
	}));
	(async () => {
		ext.outputChannel.appendLog(`waitForFilters: ${await api.waitForFilters()} ${api.filters.length}`);
	})().catch(logErrorMessage);
}

function createAccount() {
	return env.openExternal(Uri.parse('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account'));
}

function createStatusBarItem(context: ExtensionContext, api: AzureAccountExtensionApi) {
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
					const showSignedInEmail: boolean | undefined = getSettingValue(showSignedInEmailSetting);
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

export function deactivateInternal(): void {
	return;
}