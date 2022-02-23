/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { callWithTelemetryAndErrorHandling, IActionContext, registerCommand } from '@microsoft/vscode-azext-utils';
import { CancellationTokenSource, commands, EventEmitter, ExtensionContext, MessageItem, window, workspace } from 'vscode';
import { AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from '../azure-account.api';
import { AuthLibrary, authLibrarySetting, cacheKey, clientId, commonTenantId, resourceFilterSetting, tenantSetting } from '../constants';
import { AzureLoginError, getErrorMessage } from '../errors';
import { ext } from '../extensionVariables';
import { localize } from '../utils/localize';
import { logErrorMessage } from '../utils/logErrorMessage';
import { openUri } from '../utils/openUri';
import { getSettingValue, getSettingWithPrefix } from '../utils/settingUtils';
import { delay } from '../utils/timeUtils';
import { AdalAuthProvider } from './adal/AdalAuthProvider';
import { authLibraryCacheKey } from './AuthLibraryCache';
import { AuthProviderBase } from './AuthProviderBase';
import { AzureAccountExtensionApi } from './AzureAccountExtensionApi';
import { AzureAccountExtensionLegacyApi } from './AzureAccountExtensionLegacyApi';
import { getSelectedEnvironment, isADFS } from './environments';
import { getNewFilters } from './filters';
import { getAuthLibrary } from './getAuthLibrary';
import { getKey } from './getKey';
import { MsalAuthProvider } from './msal/MsalAuthProvider';
import { checkRedirectServer } from './server';
import { SubscriptionTenantCache } from './subscriptionTypes';
import { TenantIdDescription } from './TenantIdDescription';
import { updateFilters } from './updateFilters';
import { waitUntilOnline } from './waitUntilOnline';

const enableVerboseLogs: boolean = false;

interface IAzureAccountWriteable extends AzureAccountExtensionApi {
	status: AzureLoginStatus;
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class AzureAccountLoginHelper {
	private adalAuthProvider: AdalAuthProvider;
	private msalAuthProvider: MsalAuthProvider;
	private authProvider: AdalAuthProvider | MsalAuthProvider;

	public oldResourceFilter: string = '';
	public onStatusChanged: EventEmitter<AzureLoginStatus> = new EventEmitter<AzureLoginStatus>();
	public onFiltersChanged: EventEmitter<void> = new EventEmitter<void>();
	public onSessionsChanged: EventEmitter<void> = new EventEmitter<void>();
	public onSubscriptionsChanged: EventEmitter<void> = new EventEmitter<void>();

	public filtersTask: Promise<AzureResourceFilter[]> = Promise.resolve(<AzureResourceFilter[]>[]);
	public subscriptionsTask: Promise<AzureSubscription[]> = Promise.resolve(<AzureSubscription[]>[]);
	public tenantsTask: Promise<TenantIdDescription[]> = Promise.resolve(<TenantIdDescription[]>[]);

	public api: AzureAccountExtensionApi;
	public legacyApi: AzureAccountExtensionLegacyApi;

	constructor(public context: ExtensionContext, actionContext: IActionContext) {
		this.adalAuthProvider = new AdalAuthProvider(enableVerboseLogs);
		this.msalAuthProvider = new MsalAuthProvider(enableVerboseLogs);
		this.authProvider = getAuthLibrary() === 'ADAL' ?  this.adalAuthProvider : this.msalAuthProvider;

		this.api = new AzureAccountExtensionApi(this);
		this.legacyApi = new AzureAccountExtensionLegacyApi(this.api);

		registerCommand('azure-account.login', (context: IActionContext) => this.login(context, 'login').catch(logErrorMessage), 3 * 1000);
		registerCommand('azure-account.loginWithDeviceCode', (context: IActionContext) => this.login(context, 'loginWithDeviceCode').catch(logErrorMessage));
		registerCommand('azure-account.logout', () => this.logout().catch(logErrorMessage));
		context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(getSettingWithPrefix(resourceFilterSetting))) {
				actionContext.telemetry.properties.changeResourceFilter = 'true';
				updateFilters(true);
			} else if (e.affectsConfiguration(getSettingWithPrefix(authLibrarySetting))) {
				actionContext.telemetry.properties.changeAuthLibrary = 'true';
	
				const newAuthLibrary: AuthLibrary = getAuthLibrary();
				await this.context.globalState.update(authLibraryCacheKey, { lastUsedAuthLibrary: newAuthLibrary });

				const mustSignOutAndReload: string = localize('azure-account.mustSignOutAndReload', 'You must sign out and reload the window to authenticate with "{0}"', newAuthLibrary);
				const signOutAndReload: string = localize('azure-account.signOutAndReload', 'Sign Out and Reload Window');
				void window.showInformationMessage(mustSignOutAndReload, signOutAndReload).then(async value => {
					if (value === signOutAndReload) {
						actionContext.telemetry.properties.signOutAndReload = 'true';
						await this.logout();
						await commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}));
		this.initialize('activation')
			.catch(logErrorMessage);
	}

	public async login(context: IActionContext, trigger: LoginTrigger): Promise<void> {
		await ext.loginHelper.logout();

		let codePath: CodePath = 'newLogin';
		let environmentName: string = 'uninitialized';
		const cancelSource: CancellationTokenSource = new CancellationTokenSource();
		try {
			const environment: Environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const onlineTask: Promise<void> = waitUntilOnline(environment, 2000, cancelSource.token);
			const timerTask: Promise<boolean | PromiseLike<boolean> | undefined> = delay(2000, true);

			if (await Promise.race([onlineTask, timerTask])) {
				const cancel: MessageItem = { title: localize('azure-account.cancel', "Cancel") };
				await Promise.race([
					onlineTask,
					window.showInformationMessage(localize('azure-account.checkNetwork', "You appear to be offline. Please check your network connection."), cancel)
						.then(result => {
							if (result === cancel) {
								throw new AzureLoginError(localize('azure-account.offline', "Offline"));
							}
						})
				]);
				await onlineTask;
			}

			this.beginLoggingIn();

			const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
			const isAdfs: boolean = isADFS(environment);
			const useCodeFlow: boolean = trigger !== 'loginWithDeviceCode' && await checkRedirectServer(isAdfs);
			codePath = useCodeFlow ? 'newLoginCodeFlow' : 'newLoginDeviceCode';
			const loginResult = useCodeFlow ?
				await this.authProvider.login(clientId, environment, isAdfs, tenantId, openUri, redirectTimeout) :
				await this.authProvider.loginWithDeviceCode(environment, tenantId);
			await this.updateSessions(this.authProvider, environment, loginResult);
			void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'success' }, true);
		} catch (err) {
			if (err instanceof AzureLoginError && err.reason) {
				ext.outputChannel.appendLog(err.reason);
				void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'error', message: getErrorMessage(err.reason) || getErrorMessage(err) });
			} else {
				void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'failure', message: getErrorMessage(err) });
			}
			throw err;
		} finally {
			cancelSource.cancel();
			cancelSource.dispose();
			this.updateLoginStatus();
		}
	}

	private async sendLoginTelemetry(context: IActionContext, properties: { trigger: LoginTrigger, codePath: CodePath, environmentName: string, outcome: string, message?: string }, includeSubscriptions?: boolean) {
		context.telemetry.properties = {
			...context.telemetry.properties,
			...properties
		}
		if (includeSubscriptions) {
			await this.api.waitForSubscriptions();
			context.telemetry.properties.subscriptions = JSON.stringify((this.api.subscriptions).map(s => s.subscription.subscriptionId));
		}
	}

	public async logout(): Promise<void> {
		await this.api.waitForLogin();
		await this.clearSessions();
		this.updateLoginStatus();
	}

	private async initialize(trigger: LoginTrigger): Promise<void> {
		await callWithTelemetryAndErrorHandling('azure-account.initialize', async (context: IActionContext) => {
			let environmentName: string = 'uninitialized';
			const codePath: CodePath = 'tryExisting';
			try {
				await this.loadSubscriptionTenantCache();
				const environment: Environment = await getSelectedEnvironment();
				environmentName = environment.name;
				const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
				await waitUntilOnline(environment, 5000);
				this.beginLoggingIn();
				const loginResult = await this.authProvider.loginSilent(environment, tenantId);
				await this.updateSessions(this.authProvider, environment, loginResult);
				void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'success' }, true);
			} catch (err) {
				await this.clearSessions(); // clear out cached data
				if (err instanceof AzureLoginError && err.reason) {
					void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'error', message: getErrorMessage(err.reason) || getErrorMessage(err) });
				} else {
					void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'failure', message: getErrorMessage(err) });
				}
			} finally {
				this.updateLoginStatus();
			}
		});
	}

	private async loadSubscriptionTenantCache(): Promise<void> {
		const cache: SubscriptionTenantCache | undefined = this.context.globalState.get(cacheKey);
		if (cache) {
			(<IAzureAccountWriteable>this.api).status = 'LoggedIn';
			const sessions: Record<string, AzureSession> = await this.authProvider.initializeSessions(cache, this.api);

			const subscriptions: AzureSubscription[] = cache.subscriptions.map<AzureSubscription>(({ session, subscription }) => {
				const { environment, userId, tenantId } = session;
				const key: string = getKey(environment, userId, tenantId);
				return {
					session: sessions[key],
					subscription
				};
			});
			this.subscriptionsTask = Promise.resolve(subscriptions);
			this.api.subscriptions.push(...subscriptions);
			this.tenantsTask = Promise.resolve(cache.tenants);

			const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters: AzureResourceFilter[] = getNewFilters(subscriptions, resourceFilter);
			this.filtersTask = Promise.resolve(newFilters);
			this.api.filters.push(...newFilters);
		}
	}

	private beginLoggingIn(): void {
		if (this.api.status !== 'LoggedIn') {
			(<IAzureAccountWriteable>this.api).status = 'LoggingIn';
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private updateLoginStatus(): void {
		const status: AzureLoginStatus = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (this.api.status !== status) {
			(<IAzureAccountWriteable>this.api).status = status;
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private async updateSessions<TLoginResult>(authProvider: AuthProviderBase<TLoginResult>, environment: Environment, loginResult: TLoginResult): Promise<void> {
		await authProvider.updateSessions(environment, loginResult, this.api.sessions);
		this.onSessionsChanged.fire();
	}

	private async clearSessions(): Promise<void> {
		// Clear cache from all libraries: https://github.com/microsoft/vscode-azure-account/issues/309
		await this.adalAuthProvider.clearTokenCache();
		await this.msalAuthProvider.clearTokenCache();

		const sessions: AzureSession[] = this.api.sessions;
		sessions.length = 0;
		this.onSessionsChanged.fire();
	}
}

async function redirectTimeout(): Promise<void> {
	const message: string = localize('azure-account.browserDidNotConnect', 'Browser did not connect to local server within 10 seconds. Do you want to try the alternate sign in using a device code instead?');
	const useDeviceCode: string = localize('azure-account.useDeviceCode', 'Use Device Code');
	const response: string | undefined = await window.showInformationMessage(message, useDeviceCode);
	if (response) {
		await commands.executeCommand('azure-account.loginWithDeviceCode');
	}
}
