/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { callWithTelemetryAndErrorHandling, createApiProvider, createAzExtOutputChannel, createExperimentationService, IActionContext, registerCommand, registerReportIssueCommand, registerUIExtensionVariables } from '@microsoft/vscode-azext-utils';
import { AzureExtensionApiProvider } from '@microsoft/vscode-azext-utils/api';
import { createReadStream } from 'fs';
import { basename } from 'path';
import { CancellationToken, commands, ConfigurationTarget, env, ExtensionContext, ProgressLocation, Uri, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccountExtensionApi } from './azure-account.api';
import { createCloudConsole, OSes, OSName, shells } from './cloudConsole/cloudConsole';
import { AuthLibrary, authLibrarySetting, cloudSetting, displayName, extensionPrefix, showSignedInEmailSetting } from './constants';
import { ext } from './extensionVariables';
import { AuthLibraryCache, authLibraryCacheKey } from './login/AuthLibraryCache';
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
		activateContext.telemetry.properties.cloudSettingOnStartup = String(getSettingValue(cloudSetting));

		ext.experimentationService = await createExperimentationService(context);
		ext.loginHelper = new AzureAccountLoginHelper(context, activateContext);

		await checkAuthLibraryOnStartup(context, activateContext, ext.loginHelper);

		await migrateEnvironmentSetting();
		if (enableLogging) {
			logDiagnostics(context, ext.loginHelper.api);
		}
		context.subscriptions.push(createStatusBarItem(context, ext.loginHelper.api));
		registerCommand('azure-account.loginToCloud', loginToCloud);
		registerCommand('azure-account.selectSubscriptions', selectSubscriptions);
		registerCommand('azure-account.selectTenant', selectTenant);
		registerCommand('azure-account.askForLogin', askForLogin);
		registerCommand('azure-account.createAccount', createAccount);
		registerCommand('azure-account.uploadFileCloudConsole', uploadFile);
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

async function checkAuthLibraryOnStartup(extensionContext: ExtensionContext, actionContext: IActionContext, loginHelper: AzureAccountLoginHelper): Promise<void> {
	async function askThenSignOutAndReload(): Promise<void> {
		const authLibraryChanged: string = localize('azure-account.authLibraryChanged', 'The authentication library has changed. Please sign out and reload the window for it to take effect.');
		const signOutAndReload: string = localize('azure-account.signOutAndReload', 'Sign Out and Reload Window');
		
		// Purposefully await this message to block whatever command caused the extension to activate.
		await window.showInformationMessage(authLibraryChanged, signOutAndReload).then(async value => {
			if (value === signOutAndReload) {
				actionContext.telemetry.properties.signOutAtStartup = 'true';
				await loginHelper.logout();
				await commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	}

	const authLibraryOnStartup: AuthLibrary | undefined = getSettingValue(authLibrarySetting);
	actionContext.telemetry.properties.authLibraryOnStartup = String(authLibraryOnStartup);

	const authLibraryCache: AuthLibraryCache | undefined = extensionContext.globalState.get(authLibraryCacheKey);
	const lastUsedAuthLibrary: AuthLibrary | undefined = authLibraryCache?.lastUsedAuthLibrary;
	actionContext.telemetry.properties.lastUsedAuthLibrary = String(lastUsedAuthLibrary);

	await extensionContext.globalState.update(authLibraryCacheKey, { lastUsedAuthLibrary: authLibraryOnStartup });

	// Fixes https://github.com/microsoft/vscode-azure-account/issues/433
	if (!lastUsedAuthLibrary) {
		actionContext.telemetry.properties.firstActivationWithAuthLibrarySetting = 'true';

		if (authLibraryOnStartup === 'MSAL') {
			// The auth library has changed from ADAL to MSAL. We just haven't had a chance to track that change in the cache yet.
			await askThenSignOutAndReload();
		}
		// Do nothing if the auth library is ADAL or undefined. The user's auth library hasn't changed in this case (still ADAL).

	} else if (lastUsedAuthLibrary !== authLibraryOnStartup) {
		actionContext.telemetry.properties.lastUsedAuthLibraryChanged = 'true';
		await askThenSignOutAndReload();
	}
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

function cloudConsole(os: OSName) {
	const shell = ext.loginHelper.api.createCloudShell(os);
	if (shell) {
		void shell.terminal.then(terminal => terminal.show());
		return shell;
	}
}

function uploadFile(_context: IActionContext, uri?: Uri) {
	(async () => {
		let shell = shells[0];
		if (!shell) {
			const shellName = await window.showInformationMessage(localize('azure-account.uploadingRequiresOpenCloudConsole', "File upload requires an open Cloud Shell."), OSes.Linux.shellName, OSes.Windows.shellName);
			if (!shellName) {
				return;
			}
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			shell = cloudConsole(shellName === OSes.Linux.shellName ? 'Linux' : 'Windows')!;
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
	const statusBarItem = window.createStatusBarItem('azure-account.status');
	statusBarItem.name = localize('azure-account.status', 'Azure Account Status');
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