/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { CancellationTokenSource, commands, EventEmitter, ExtensionContext, MessageItem, window, workspace } from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import { AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from '../azure-account.api';
import { authLibrarySetting, cacheKey, clientId, cloudSetting, commonTenantId, customCloudArmUrlSetting, resourceFilterSetting, tenantSetting } from '../constants';
import { AzureLoginError, getErrorMessage } from '../errors';
import { localize } from '../utils/localize';
import { openUri } from '../utils/openUri';
import { getAuthLibrary, getSettingValue, getSettingWithPrefix } from '../utils/settingUtils';
import { delay } from '../utils/timeUtils';
import { AdalAuthProvider } from './adal/AdalAuthProvider';
import { AuthProviderBase } from './AuthProviderBase';
import { AzureAccountExtensionApi } from './AzureAccountExtensionApi';
import { AzureAccountExtensionLegacyApi } from './AzureAccountExtensionLegacyApi';
import { getSelectedEnvironment, isADFS } from './environments';
import { getNewFilters } from './filters';
import { getKey } from './getKey';
import { MsalAuthProvider } from './msal/MsalAuthProvider';
import { checkRedirectServer } from './server';
import { ISubscriptionCache } from './subscriptionTypes';
import { updateFilters } from './updateFilters';
import { waitUntilOnline } from './waitUntilOnline';

const enableVerboseLogs: boolean = false;

interface IAzureAccountWriteable extends AzureAccountExtensionApi {
	status: AzureLoginStatus;
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange' | 'customCloudARMUrlChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class AzureAccountLoginHelper {
	private doLogin: boolean = false;
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

	public api: AzureAccountExtensionApi;
	public legacyApi: AzureAccountExtensionLegacyApi;

	constructor(public context: ExtensionContext) {
		this.adalAuthProvider = new AdalAuthProvider(enableVerboseLogs);
		this.msalAuthProvider = new MsalAuthProvider(enableVerboseLogs);
		this.authProvider = getAuthLibrary() === 'ADAL' ?  this.adalAuthProvider : this.msalAuthProvider;

		this.api = new AzureAccountExtensionApi(this);
		this.legacyApi = new AzureAccountExtensionLegacyApi(this.api);

		context.subscriptions.push(commands.registerCommand('azure-account.login', () => this.login('login').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => this.login('loginWithDeviceCode').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) || e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) || e.affectsConfiguration(getSettingWithPrefix(customCloudArmUrlSetting))) {
				const doLogin: boolean = this.doLogin;
				this.doLogin = false;
				this.initialize(e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) ? 'cloudChange' : e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) ? 'tenantChange' : 'customCloudARMUrlChange', doLogin)
					.catch(console.error);
			} else if (e.affectsConfiguration(getSettingWithPrefix(resourceFilterSetting))) {
				updateFilters(true);
			} else if (e.affectsConfiguration(getSettingWithPrefix(authLibrarySetting))) {
				const mustSignOutAndReload: string = localize('azure-account.mustSignOutAndReload', 'You must sign out and reload the window to authenticate with "{0}"', getAuthLibrary());
				const signOutAndReload: string = localize('azure-account.signOutAndReload', 'Sign Out and Reload Window');
				void window.showInformationMessage(mustSignOutAndReload, signOutAndReload).then(async value => {
					if (value === signOutAndReload) {
						await this.logout();
						await commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}));
		this.initialize('activation', false, true)
			.catch(console.error);
	}

	public async login(trigger: LoginTrigger): Promise<void> {
		await callWithTelemetryAndErrorHandling('azure-account.login', async (context: IActionContext) => {
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
					console.error(err.reason);
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
		});
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

	private async initialize(trigger: LoginTrigger, doLogin?: boolean, migrateToken?: boolean): Promise<void> {
		await callWithTelemetryAndErrorHandling('azure-account.initialize', async (context: IActionContext) => {
			let environmentName: string = 'uninitialized';
			const codePath: CodePath = 'tryExisting';
			try {
				await this.loadSubscriptionCache();
				const environment: Environment = await getSelectedEnvironment();
				environmentName = environment.name;
				const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
				await waitUntilOnline(environment, 5000);
				this.beginLoggingIn();
				const loginResult = await this.authProvider.loginSilent(environment, tenantId, migrateToken);
				await this.updateSessions(this.authProvider, environment, loginResult);
				void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'success' }, true);
			} catch (err) {
				await this.clearSessions(); // clear out cached data
				if (err instanceof AzureLoginError && err.reason) {
					void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'error', message: getErrorMessage(err.reason) || getErrorMessage(err) });
				} else {
					void this.sendLoginTelemetry(context, { trigger, codePath, environmentName, outcome: 'failure', message: getErrorMessage(err) });
				}
				if (doLogin) {
					await this.login(trigger);
				}
			} finally {
				this.updateLoginStatus();
			}
		});
	}

	private async loadSubscriptionCache(): Promise<void> {
		const cache: ISubscriptionCache | undefined = this.context.globalState.get(cacheKey);
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

			const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters: AzureSubscription[] = getNewFilters(subscriptions, resourceFilter);
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
