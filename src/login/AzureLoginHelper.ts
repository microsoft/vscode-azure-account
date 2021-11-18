/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient, SubscriptionModels } from '@azure/arm-subscriptions';
import { Environment } from '@azure/ms-rest-azure-env';
import { AccountInfo } from '@azure/msal-node';
import { CancellationTokenSource, commands, ConfigurationTarget, EventEmitter, ExtensionContext, MessageItem, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import { AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from '../azure-account.api';
import { authLibrarySetting, azureCustomCloud, azurePPE, cacheKey, clientId, cloudSetting, commonTenantId, customCloudArmUrlSetting, extensionPrefix, resourceFilterSetting, tenantSetting } from '../constants';
import { AzureLoginError, getErrorMessage } from '../errors';
import { listAll } from '../utils/arrayUtils';
import { localize } from '../utils/localize';
import { openUri } from '../utils/openUri';
import { getAuthLibrary, getSettingValue, getSettingWithPrefix } from '../utils/settingUtils';
import { delay } from '../utils/timeUtils';
import { AdalAuthProvider } from './adal/AdalAuthProvider';
import { AuthProviderBase } from './AuthProviderBase';
import { AzureAccountExtensionApi } from './AzureAccountExtensionApi';
import { AzureAccountExtensionLegacyApi } from './AzureAccountExtensionLegacyApi';
import { AzureSessionInternal } from './AzureSessionInternal';
import { getEnvironments, getSelectedEnvironment, isADFS } from './environments';
import { addFilter, getNewFilters, removeFilter } from './filters';
import { getKey } from './getKey';
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

interface IAzureAccountWriteable extends AzureAccountExtensionApi {
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
	private oldResourceFilter: string = '';
	private doLogin: boolean = false;
	private adalAuthProvider: AdalAuthProvider;
	private msalAuthProvider: MsalAuthProvider;
	private authProvider: AdalAuthProvider | MsalAuthProvider;

	public onStatusChanged: EventEmitter<AzureLoginStatus> = new EventEmitter<AzureLoginStatus>();
	public onFiltersChanged: EventEmitter<void> = new EventEmitter<void>();
	public onSessionsChanged: EventEmitter<void> = new EventEmitter<void>();
	public onSubscriptionsChanged: EventEmitter<void> = new EventEmitter<void>();

	public filtersTask: Promise<AzureResourceFilter[]> = Promise.resolve(<AzureResourceFilter[]>[]);
	public subscriptionsTask: Promise<AzureSubscription[]> = Promise.resolve(<AzureSubscription[]>[]);

	public api: AzureAccountExtensionApi;
	public legacyApi: AzureAccountExtensionLegacyApi;

	constructor(private context: ExtensionContext) {
		this.adalAuthProvider = new AdalAuthProvider(enableVerboseLogs);
		this.msalAuthProvider = new MsalAuthProvider(enableVerboseLogs);
		this.authProvider = getAuthLibrary() === 'ADAL' ?  this.adalAuthProvider : this.msalAuthProvider;

		this.api = new AzureAccountExtensionApi(this);
		this.legacyApi = new AzureAccountExtensionLegacyApi(this.api);

		context.subscriptions.push(commands.registerCommand('azure-account.login', () => this.login('login').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => this.login('loginWithDeviceCode').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginToCloud', () => this.loginToCloud().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
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
		await callWithTelemetryAndErrorHandling('azure-account.login', async (context: IActionContext) => {
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
				await this.sendLoginTelemetry(context, trigger, path, environmentName, 'success', undefined, true);
			} catch (err) {
				if (err instanceof AzureLoginError && err.reason) {
					console.error(err.reason);
					await this.sendLoginTelemetry(context, trigger, path, environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
				} else {
					await this.sendLoginTelemetry(context, trigger, path, environmentName, 'failure', getErrorMessage(err));
				}
				throw err;
			} finally {
				cancelSource.cancel();
				cancelSource.dispose();
				this.updateLoginStatus();
			}
		});
	}

	private async sendLoginTelemetry(context: IActionContext, trigger: LoginTrigger, path: CodePath, cloud: string, outcome: string, message?: string, includeSubscriptions?: boolean) {
		context.telemetry.properties = {
			...context.telemetry.properties,
			trigger,
			path,
			cloud,
			outcome,
			message
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
		await callWithTelemetryAndErrorHandling('azure-account.initialize', async (context: IActionContext) => {
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
				void this.sendLoginTelemetry(context, trigger, 'tryExisting', environmentName, 'success', undefined, true);
			} catch (err) {
				await this.clearSessions(); // clear out cached data
				if (err instanceof AzureLoginError && err.reason) {
					void this.sendLoginTelemetry(context, trigger, 'tryExisting', environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
				} else {
					void this.sendLoginTelemetry(context, trigger, 'tryExisting', environmentName, 'failure', getErrorMessage(err));
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
			const subscriptions: AzureSubscription[] = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateSubscriptionCache(): void {
		if (this.api.status !== 'LoggedIn') {
			void this.context.globalState.update(cacheKey, undefined);
			return;
		}
		const cache: ISubscriptionCache = {
			subscriptions: this.api.subscriptions.map(({ session, subscription }) => ({
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
		this.api.subscriptions.push(...subscriptions);
		return subscriptions;
	}

	private async updateSubscriptions(): Promise<void> {
		await this.api.waitForLogin();
		this.subscriptionsTask = this.loadSubscriptions();
		this.api.subscriptions.splice(0, this.api.subscriptions.length, ...await this.subscriptionsTask);
		this.updateSubscriptionCache();
		this.onSubscriptionsChanged.fire();
	}

	private async askForLogin(): Promise<unknown> {
		if (this.api.status === 'LoggedIn') {
			return;
		}
		const login: MessageItem = { title: localize('azure-account.login', "Sign In") };
		const result: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.loginFirst', "You are not signed in. Sign in to continue."), login);
		return result === login && commands.executeCommand('azure-account.login');
	}

	private async selectSubscriptions(): Promise<unknown> {
		return await callWithTelemetryAndErrorHandling('azure-account.selectSubscriptions', async (context: IActionContext) => {
			if (!(await this.api.waitForSubscriptions())) {
				context.telemetry.properties.outcome = 'notLoggedIn';
				return commands.executeCommand('azure-account.askForLogin');
			}

			try {
				const azureConfig: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
				const resourceFilter: string[] = (azureConfig.get<string[]>(resourceFilterSetting) || ['all']).slice();
				let filtersChanged: boolean = false;

				const subscriptions = this.subscriptionsTask
					.then(list => this.getSubscriptionItems(list, resourceFilter));
				const source: CancellationTokenSource = new CancellationTokenSource();
				const cancellable: Promise<ISubscriptionItem[]> = subscriptions.then(s => {
					if (!s.length) {
						context.telemetry.properties.outcome = 'noSubscriptionsFound';
						source.cancel();
						this.showNoSubscriptionsFoundNotification()
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
				context.telemetry.properties.outcome = 'success';
			} catch (error) {
				context.telemetry.properties.outcome = 'error';
				throw error;
			}
		});
	}

	private async showNoSubscriptionsFoundNotification(): Promise<void> {
		const noSubscriptionsFound = localize('azure-account.noSubscriptionsFound', 'No subscriptions were found. Check out our troubleshooting page for common solutions to this problem or setup your account.');
		const openTroubleshooting = localize('azure-account.openTroubleshooting', 'Open Troubleshooting');
		const setupAccount = localize('azure-account.setupAccount', 'Setup Account');
		const response = await window.showInformationMessage(noSubscriptionsFound, openTroubleshooting, setupAccount);
		if (response === openTroubleshooting) {
			void openUri('https://aka.ms/AAevvhr');
		} else if (response === setupAccount) {
			void openUri('https://aka.ms/AAevntl');
		}
	}

	private async loadSubscriptions(): Promise<AzureSubscription[]> {
		const lists: AzureSubscription[][] = await Promise.all(this.api.sessions.map(session => {
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
		this.api.filters.push(...newFilters);
	}

	private updateFilters(configChange = false): void {
		const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
		if (configChange && JSON.stringify(resourceFilter) === this.oldResourceFilter) {
			return;
		}
		this.filtersTask = (async () => {
			await this.api.waitForSubscriptions();
			const subscriptions: AzureSubscription[] = await this.subscriptionsTask;
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters: AzureSubscription[] = getNewFilters(subscriptions, resourceFilter);
			this.api.filters.splice(0, this.api.filters.length, ...newFilters);
			this.onFiltersChanged.fire();
			return this.api.filters;
		})();
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
