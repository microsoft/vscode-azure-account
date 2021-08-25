/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient, SubscriptionModels } from '@azure/arm-subscriptions';
import { Environment } from '@azure/ms-rest-azure-env';
import { AccountInfo } from '@azure/msal-node';
import { CancellationTokenSource, commands, ConfigurationTarget, Disposable, EventEmitter, ExtensionContext, MessageItem, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from '../azure-account.api';
import { createCloudConsole } from '../cloudConsole/cloudConsole';
import { authLibrarySetting, azureCustomCloud, azurePPE, cacheKey, clientId, cloudSetting, commonTenantId, customCloudArmUrlSetting, extensionPrefix, resourceFilterSetting, tenantSetting } from '../constants';
import { AzureLoginError, getErrorMessage } from '../errors';
import { TelemetryReporter } from '../telemetry';
import { listAll } from '../utils/arrayUtils';
import { localize } from '../utils/localize';
import { openUri } from '../utils/openUri';
import { getAuthLibrary, getSettingValue, getSettingWithPrefix } from '../utils/settingUtils';
import { delay } from '../utils/timeUtils';
import { AdalAuthProvider } from './adal/AdalAuthProvider';
import { AuthProviderBase } from './AuthProviderBase';
import { getEnvironments, getSelectedEnvironment, isADFS } from './environments';
import { addFilter, getNewFilters, removeFilter } from './filters';
import { getKey } from './getKey';
import { AzureAccountInternal, AzureSessionInternal } from './internalApiTypes';
import { MsalAuthProvider } from './msal/MsalAuthProvider';
import { checkRedirectServer } from './server';
import { waitUntilOnline } from './waitUntilOnline';

const environmentLabels: Record<string, string> = {
	AzureCloud: localize('azure-account.azureCloud', 'Azure'),
	AzureChinaCloud: localize('azure-account.azureChinaCloud', 'Azure China'),
	AzureGermanCloud: localize('azure-account.azureGermanyCloud', 'Azure Germany'),
	AzureUSGovernment: localize('azure-account.azureUSCloud', 'Azure US Government'),
	[azureCustomCloud]: localize('azure-account.azureCustomCloud', 'Azure Custom Cloud'),
	[azurePPE]: localize('azure-account.azurePPE', 'Azure PPE'),
};

const enableVerboseLogs: boolean = false;

interface IAzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

export interface ISubscriptionItem extends QuickPickItem {
	subscription: AzureSubscription;
}

export interface ISubscriptionCache {
	subscriptions: {
		session: {
			environment: string;
			userId: string;
			tenantId: string;
			accountInfo?: AccountInfo;
		};
		subscription: SubscriptionModels.Subscription;
	}[];
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange' | 'customCloudARMUrlChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class AzureLoginHelper {
	private onStatusChanged: EventEmitter<AzureLoginStatus> = new EventEmitter<AzureLoginStatus>();
	private onSessionsChanged: EventEmitter<void> = new EventEmitter<void>();

	private subscriptionsTask: Promise<AzureSubscription[]> = Promise.resolve(<AzureSubscription[]>[]);
	private onSubscriptionsChanged: EventEmitter<void> = new EventEmitter<void>();

	private filtersTask: Promise<AzureResourceFilter[]> = Promise.resolve(<AzureResourceFilter[]>[]);
	private onFiltersChanged: EventEmitter<void> = new EventEmitter<void>();

	private oldResourceFilter: string = '';
	private doLogin: boolean = false;

	private authProvider: AdalAuthProvider | MsalAuthProvider;

	private useLegacyApi: boolean | undefined;
	private apis: AzureAccount[];

	public api: AzureAccountInternal;
	public legacyApi: AzureAccountInternal;

	constructor(private context: ExtensionContext, private reporter: TelemetryReporter) {
		// Allow switching between libraries via a setting for testing purposes
		this.authProvider = getAuthLibrary() === 'ADAL' ?
			new AdalAuthProvider(enableVerboseLogs) :
			new MsalAuthProvider(enableVerboseLogs);

		this.api = {
			apiVersion: '0.1.0',
			isLegacyApi: false,
			status: 'Initializing',
			onStatusChanged: this.onStatusChanged.event,
			waitForLogin: () => this.waitForLogin(),
			sessions: [],
			onSessionsChanged: this.onSessionsChanged.event,
			subscriptions: [],
			onSubscriptionsChanged: this.onSubscriptionsChanged.event,
			waitForSubscriptions: () => this.waitForSubscriptions(),
			filters: [],
			onFiltersChanged: this.onFiltersChanged.event,
			waitForFilters: () => this.waitForFilters(),
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			createCloudShell: os => createCloudConsole(this.api, this.reporter, os)!
		};
		this.legacyApi = {
			apiVersion: '0.0.0',
			isLegacyApi: true,
			status: 'Initializing',
			onStatusChanged: this.onStatusChanged.event,
			waitForLogin: () => this.waitForLogin(true),
			sessions: [],
			onSessionsChanged: this.onSessionsChanged.event,
			subscriptions: [],
			onSubscriptionsChanged: this.onSubscriptionsChanged.event,
			waitForSubscriptions: () => this.waitForSubscriptions(true),
			filters: [],
			onFiltersChanged: this.onFiltersChanged.event,
			waitForFilters: () => this.waitForFilters(true),
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			createCloudShell: os => createCloudConsole(this.legacyApi, this.reporter, os)!
		};
		this.apis = [this.api, this.legacyApi];

		context.subscriptions.push(commands.registerCommand('azure-account.login', () => this.login('login').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => this.login('loginWithDeviceCode').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginToCloud', () => this.loginToCloud().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
		context.subscriptions.push(this.legacyApi.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		context.subscriptions.push(this.legacyApi.onSubscriptionsChanged(() => this.updateFilters()));
		context.subscriptions.push(workspace.onDidChangeConfiguration(async e => {
			if (e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) || e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) || e.affectsConfiguration(getSettingWithPrefix(customCloudArmUrlSetting))) {
				const doLogin: boolean = this.doLogin;
				this.doLogin = false;
				this.initialize(e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) ? 'cloudChange' : e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) ? 'tenantChange' : 'customCloudARMUrlChange', doLogin)
					.catch(console.error);
			} else if (e.affectsConfiguration(getSettingWithPrefix(resourceFilterSetting))) {
				this.updateFilters(true);
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
		let path: CodePath = 'newLogin';
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
			path = useCodeFlow ? 'newLoginCodeFlow' : 'newLoginDeviceCode';
			const loginResult = useCodeFlow ?
				await this.authProvider.login(clientId, environment, isAdfs, tenantId, openUri, redirectTimeout) :
				await this.authProvider.loginWithDeviceCode(environment, tenantId);
			await this.updateSessions(this.authProvider, environment, loginResult);
			void this.sendLoginTelemetry(trigger, path, environmentName, 'success', undefined, true);
		} catch (err) {
			if (err instanceof AzureLoginError && err.reason) {
				console.error(err.reason);
				void this.sendLoginTelemetry(trigger, path, environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
			} else {
				void this.sendLoginTelemetry(trigger, path, environmentName, 'failure', getErrorMessage(err));
			}
			throw err;
		} finally {
			cancelSource.cancel();
			cancelSource.dispose();
			this.updateLoginStatus();
		}
	}

	private async sendLoginTelemetry(trigger: LoginTrigger, path: CodePath, cloud: string, outcome: string, message?: string, includeSubscriptions?: boolean): Promise<void> {
		/* __GDPR__
		   "login" : {
			  "trigger" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "path": { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "cloud" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "outcome" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
			  "message": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth" },
			  "subscriptions" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "endPoint": "AzureSubscriptionId" }
		   }
		 */
		const event: Record<string, string> = { trigger, path, cloud, outcome };
		if (message) {
			event.message = message;
		}
		if (includeSubscriptions) {
			await this.waitForSubscriptions();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			event.subscriptions = JSON.stringify((await this.subscriptionsTask).map(s => s.subscription.subscriptionId!));
		}
		this.reporter.sendSanitizedEvent('login', event);
	}

	public async logout(): Promise<void> {
		await this.getApi().waitForLogin();
		await this.clearSessions();
		this.updateLoginStatus();
	}

	private async loginToCloud(): Promise<void> {
		const current: Environment = await getSelectedEnvironment();
		const selected: QuickPickItem & { environment: Environment } | undefined = await window.showQuickPick<QuickPickItem & { environment: Environment }>(getEnvironments(true /* includePartial */)
			.then(environments => environments.map(environment => ({
				label: environmentLabels[environment.name],
				description: environment.name === current.name ? localize('azure-account.currentCloud', '(Current)') : undefined,
				environment
			}))), {
			placeHolder: localize('azure-account.chooseCloudToLogin', "Choose cloud to sign in to")
		});

		if (selected) {
			const config: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
			if (config.get(cloudSetting) !== selected.environment.name) {
				let armUrl: string | undefined;
				if (selected.environment.name === azureCustomCloud) {
					armUrl = await window.showInputBox({
						prompt: localize('azure-account.enterArmUrl', "Enter the Azure Resource Manager endpoint"),
						placeHolder: 'https://management.local.azurestack.external',
						ignoreFocusOut: true
					});
					if (!armUrl) {
						// directly return when user didn't type in anything or press esc for resourceManagerEndpointUrl inputbox
						return;
					}
				}
				const tenantId: string | undefined = await window.showInputBox({
					prompt: localize('azure-account.enterTenantId', "Enter the tenant id"),
					placeHolder: localize('azure-account.tenantIdPlaceholder', "Enter your tenant id, or '{0}' for the default tenant", commonTenantId),
					ignoreFocusOut: true});
				if (tenantId) {
					if (armUrl) {
						await config.update(customCloudArmUrlSetting, armUrl, getCurrentTarget(config.inspect(customCloudArmUrlSetting)));
					}
					await config.update(tenantSetting, tenantId, getCurrentTarget(config.inspect(tenantSetting)));
					// if outside of normal range, set ppe setting
					await config.update(tenantSetting, selected.environment.name, getCurrentTarget(config.inspect(cloudSetting)));
				} else {
					return;
				}
			}
			return this.login('loginToCloud');
		}
	}

	private async initialize(trigger: LoginTrigger, doLogin?: boolean, migrateToken?: boolean): Promise<void> {
		let environmentName: string = 'uninitialized';
		try {
			await this.loadSubscriptionCache();
			const environment: Environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
			await waitUntilOnline(environment, 5000);
			this.beginLoggingIn();
			const loginResult = await this.authProvider.loginSilent(environment, tenantId, migrateToken);
			await this.updateSessions(this.authProvider, environment, loginResult);
			void this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'success', undefined, true);
		} catch (err) {
			await this.clearSessions(); // clear out cached data
			if (err instanceof AzureLoginError && err.reason) {
				void this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
			} else {
				void this.sendLoginTelemetry(trigger, 'tryExisting', environmentName, 'failure', getErrorMessage(err));
			}
			if (doLogin) {
				await this.login(trigger);
			}
		} finally {
			this.updateLoginStatus();
		}
	}

	private async loadSubscriptionCache(): Promise<void> {
		const cache: ISubscriptionCache | undefined = this.context.globalState.get(cacheKey);
		if (cache) {
			(<IAzureAccountWriteable>this.api).status = 'LoggedIn';
			(<IAzureAccountWriteable>this.legacyApi).status = 'LoggedIn';
			const sessions: Record<string, AzureSession> = await this.authProvider.initializeSessions(cache, this.api, this.legacyApi);
			const subscriptions: AzureSubscription[] = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateSubscriptionCache(api: AzureAccount): void {
		if (api.status !== 'LoggedIn') {
			void this.context.globalState.update(cacheKey, undefined);
			return;
		}
		const cache: ISubscriptionCache = {
			subscriptions: api.subscriptions.map(({ session, subscription }) => ({
				session: {
					environment: session.environment.name,
					userId: session.userId,
					tenantId: session.tenantId,
					accountInfo: (<AzureSessionInternal>session).accountInfo
				},
				subscription
			}))
		}
		void this.context.globalState.update(cacheKey, cache);
	}

	private beginLoggingIn(): void {
		const api: AzureAccount = this.getApi();
		if (api.status !== 'LoggedIn') {
			(<IAzureAccountWriteable>api).status = 'LoggingIn';
			this.onStatusChanged.fire(api.status);
		}
	}

	private updateLoginStatus(): void {
		const api: AzureAccount = this.getApi();
		const status: AzureLoginStatus = api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (api.status !== status) {
			(<IAzureAccountWriteable>api).status = status;
			this.onStatusChanged.fire(api.status);
		}
	}

	private async updateSessions<TLoginResult>(authProvider: AuthProviderBase<TLoginResult>, environment: Environment, loginResult: TLoginResult): Promise<void> {
		for (const api of this.apis) {
			await authProvider.updateSessions(environment, loginResult, api.sessions);
		}
		this.onSessionsChanged.fire();
	}

	private async clearSessions(): Promise<void> {
		await this.authProvider.clearTokenCache();
		for (const api of this.apis) {
			const sessions: AzureSession[] = api.sessions;
			sessions.length = 0;
		}
		this.onSessionsChanged.fire();
	}

	private async waitForSubscriptions(useLegacyApi?: boolean): Promise<boolean> {
		this.setUseLegacyApi('waitForSubscriptions', useLegacyApi);

		if (!(await this.getApi().waitForLogin())) {
			return false;
		}
		await this.subscriptionsTask;
		return true;
	}

	private initializeSubscriptions(cache: ISubscriptionCache, sessions: Record<string, AzureSession>): AzureSubscription[] {
		const subscriptions: AzureSubscription[] = cache.subscriptions.map<AzureSubscription>(({ session, subscription }) => {
			const { environment, userId, tenantId } = session;
			const key: string = getKey(environment, userId, tenantId);
			return {
				session: sessions[key],
				subscription
			};
		});
		this.subscriptionsTask = Promise.resolve(subscriptions);
		for (const api of this.apis) {
			api.subscriptions.push(...subscriptions);
		}
		return subscriptions;
	}

	private async updateSubscriptions(): Promise<void> {
		const api: AzureAccount = this.getApi();
		await api.waitForLogin();
		this.subscriptionsTask = this.loadSubscriptions(api);
		api.subscriptions.splice(0, api.subscriptions.length, ...await this.subscriptionsTask);
		this.updateSubscriptionCache(api);
		this.onSubscriptionsChanged.fire();
	}

	private async askForLogin(): Promise<unknown> {
		if (this.getApi().status === 'LoggedIn') {
			return;
		}
		const login: MessageItem = { title: localize('azure-account.login', "Sign In") };
		const result: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.loginFirst', "You are not signed in. Sign in to continue."), login);
		return result === login && commands.executeCommand('azure-account.login');
	}

	private async selectSubscriptions(): Promise<unknown> {
		if (!(await this.waitForSubscriptions())) {
			return commands.executeCommand('azure-account.askForLogin');
		}

		const azureConfig: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
		const resourceFilter: string[] = (azureConfig.get<string[]>(resourceFilterSetting) || ['all']).slice();
		let filtersChanged: boolean = false;

		const subscriptions = this.subscriptionsTask
			.then(list => this.getSubscriptionItems(list, resourceFilter));
		const source: CancellationTokenSource = new CancellationTokenSource();
		const cancellable: Promise<ISubscriptionItem[]> = subscriptions.then(s => {
			if (!s.length) {
				source.cancel();
				this.noSubscriptionsFound()
					.catch(console.error);
			}
			return s;
		});
		const picks: QuickPickItem[] | undefined = await window.showQuickPick(cancellable, { canPickMany: true, placeHolder: 'Select Subscriptions' }, source.token);
		if (picks) {
			if (resourceFilter[0] === 'all') {
				resourceFilter.splice(0, 1);
				for (const subscription of await subscriptions) {
					addFilter(resourceFilter, subscription);
				}
			}
			for (const subscription of await subscriptions) {
				if (subscription.picked !== (picks.indexOf(subscription) !== -1)) {
					filtersChanged = true;
					if (subscription.picked) {
						removeFilter(resourceFilter, subscription);
					} else {
						addFilter(resourceFilter, subscription);
					}
				}
			}
		}

		if (filtersChanged) {
			await this.updateConfiguration(azureConfig, resourceFilter);
		}
	}

	private async noSubscriptionsFound(): Promise<void> {
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const response: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.noSubscriptionsFound', "No subscriptions were found. Set up your account at https://azure.microsoft.com/en-us/free/."), open);
		if (response === open) {
			void openUri('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account');
		}
	}

	private async loadSubscriptions(api: AzureAccount): Promise<AzureSubscription[]> {
		const lists: AzureSubscription[][] = await Promise.all(api.sessions.map(session => {
			const client: SubscriptionClient = new SubscriptionClient(session.credentials2, { baseUri: session.environment.resourceManagerEndpointUrl });
			return listAll(client.subscriptions, client.subscriptions.list())
				.then(list => list.map(subscription => ({
					session,
					subscription,
				})));
		}));
		const subscriptions: AzureSubscription[] = (<AzureSubscription[]>[]).concat(...lists);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		subscriptions.sort((a, b) => a.subscription.displayName!.localeCompare(b.subscription.displayName!));
		return subscriptions;
	}

	private getSubscriptionItems(subscriptions: AzureSubscription[], resourceFilter: string[]): ISubscriptionItem[] {
		return subscriptions.map(subscription => {
			const picked: boolean = resourceFilter.indexOf(`${subscription.session.tenantId}/${subscription.subscription.subscriptionId}`) !== -1 || resourceFilter[0] === 'all';
			return <ISubscriptionItem>{
				label: subscription.subscription.displayName,
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				description: subscription.subscription.subscriptionId!,
				subscription,
				picked,
			};
		});
	}

	private async updateConfiguration(azureConfig: WorkspaceConfiguration, resourceFilter: string[]): Promise<void> {
		const resourceFilterConfig = azureConfig.inspect<string[]>(resourceFilterSetting);
		const target: ConfigurationTarget = getCurrentTarget(resourceFilterConfig);
		await azureConfig.update(resourceFilterSetting, resourceFilter[0] !== 'all' ? resourceFilter : undefined, target);
	}

	private initializeFilters(subscriptions: AzureSubscription[]): void {
		const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
		this.oldResourceFilter = JSON.stringify(resourceFilter);
		const newFilters: AzureSubscription[] = getNewFilters(subscriptions, resourceFilter);
		this.filtersTask = Promise.resolve(newFilters);
		for (const api of this.apis) {
			api.filters.push(...newFilters);
		}
	}

	private updateFilters(configChange = false, useLegacyApi?: boolean): void {
		this.setUseLegacyApi('updateFilters', useLegacyApi);
		const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
		if (configChange && JSON.stringify(resourceFilter) === this.oldResourceFilter) {
			return;
		}
		this.filtersTask = (async () => {
			await this.waitForSubscriptions();
			const subscriptions: AzureSubscription[] = await this.subscriptionsTask;
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters: AzureSubscription[] = getNewFilters(subscriptions, resourceFilter);
			const api: AzureAccount = this.getApi();
			api.filters.splice(0, api.filters.length, ...newFilters);
			this.onFiltersChanged.fire();
			return api.filters;
		})();
	}

	private async waitForLogin(useLegacyApi?: boolean): Promise<boolean> {
		this.setUseLegacyApi('waitForLogin', useLegacyApi);

		const api: AzureAccount = this.getApi();
		switch (api.status) {
			case 'LoggedIn':
				return true;
			case 'LoggedOut':
				return false;
			case 'Initializing':
			case 'LoggingIn':
				return new Promise<boolean>(resolve => {
					const subscription: Disposable = api.onStatusChanged(() => {
						subscription.dispose();
						resolve(this.waitForLogin());
					});
				});
			default:
				const status: never = api.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	}

	private async waitForFilters(useLegacyApi?: boolean): Promise<boolean> {
		this.setUseLegacyApi('waitForFilters', useLegacyApi);

		if (!(await this.waitForSubscriptions())) {
			return false;
		}
		await this.filtersTask;
		return true;
	}

	private getApi(): AzureAccount {
		return this.useLegacyApi ? this.legacyApi : this.api;
	}

	private setUseLegacyApi(eventName: string, useLegacyApi?: boolean) {
		this.useLegacyApi = this.useLegacyApi === undefined ? useLegacyApi : this.useLegacyApi;
		this.reporter.sendSanitizedEvent(eventName, { 'useLegacyApi': String(!!this.useLegacyApi) });
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

function getCurrentTarget(config: { key: string; defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown, workspaceFolderValue?: unknown } | undefined): ConfigurationTarget {
	if (config) {
		if (config.workspaceFolderValue) {
			return ConfigurationTarget.WorkspaceFolder;
		} else if (config.workspaceValue) {
			return ConfigurationTarget.Workspace;
		} else if (config.globalValue) {
			return ConfigurationTarget.Global;
		}
	}
	return ConfigurationTarget.Global;
}
