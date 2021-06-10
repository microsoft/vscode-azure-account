/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient } from '@azure/arm-subscriptions';
import { TenantIdDescription } from '@azure/arm-subscriptions/esm/models';
import { Environment } from '@azure/ms-rest-azure-env';
import { DeviceTokenCredentials as DeviceTokenCredentials2, TokenCredentialsBase } from '@azure/ms-rest-nodeauth';
import { AuthenticationContext, Logging, MemoryCache, TokenResponse } from 'adal-node';
import { DeviceTokenCredentials as DeviceTokenCredentials } from 'ms-rest-azure';
import { CancellationTokenSource, commands, ConfigurationChangeEvent, ConfigurationTarget, EventEmitter, ExtensionContext, MessageItem, OutputChannel, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from './azure-account.api';
import { addTokenToCache, clearTokenCache, deleteRefreshToken, getStoredCredentials, ISubscriptionCache, ProxyTokenCache, storeRefreshToken } from './cache';
import { checkIsOnline } from './checkIsOnline';
import { createCloudConsole } from './cloudConsole';
import * as codeFlowLogin from './codeFlowLogin';
import { azureCustomCloud, cacheKey, clientId, cloudSetting, commonTenantId, customCloudArmUrlSetting, displayName, enableLogging, environmentLabels, prefix, resourceFilterSetting, staticEnvironmentNames, tenantSetting } from './constants';
import { deviceLogin } from './deviceLogin';
import { getEnvironments, getSelectedEnvironment } from './environments';
import { AzureLoginError, getErrorMessage } from './errors';
import { addFilter, getNewFilters, removeFilter } from './filters';
import { TelemetryReporter } from './telemetry';
import { listAll } from './utils/arrayUtils';
import { localize } from './utils/localize';
import { openUri } from './utils/openUri';
import { getSettingValue, getSettingWithPrefix } from './utils/settingUtils';
import { delay } from './utils/timeUtils';

interface IAzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

export interface ISubscriptionItem extends QuickPickItem {
	subscription: AzureSubscription;
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange' | 'customCloudARMUrlChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class AzureLogin {
	private onStatusChanged: EventEmitter<AzureLoginStatus> = new EventEmitter<AzureLoginStatus>();
	private onSessionsChanged: EventEmitter<void> = new EventEmitter<void>();

	private subscriptionsTask: Promise<AzureSubscription[]> = Promise.resolve(<AzureSubscription[]>[]);
	private onSubscriptionsChanged: EventEmitter<void> = new EventEmitter<void>();

	private filtersTask: Promise<AzureResourceFilter[]> = Promise.resolve(<AzureResourceFilter[]>[]);
	private onFiltersChanged: EventEmitter<void> = new EventEmitter<void>();

	private tokenCache: MemoryCache = new MemoryCache();
	private delayedCache: ProxyTokenCache = new ProxyTokenCache(this.tokenCache);
	private oldResourceFilter: string = '';
	private doLogin: boolean = false;

	public api: AzureAccount = {
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
		createCloudShell: os => createCloudConsole(this.api, this.reporter, os)
	};

	constructor(private context: ExtensionContext, private reporter: TelemetryReporter) {
		context.subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
		context.subscriptions.push(workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
			if (e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) || e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) || e.affectsConfiguration(getSettingWithPrefix(customCloudArmUrlSetting))) {
				const doLogin: boolean = this.doLogin;
				this.doLogin = false;
				this.initialize(e.affectsConfiguration(getSettingWithPrefix(cloudSetting)) ? 'cloudChange' : e.affectsConfiguration(getSettingWithPrefix(tenantSetting)) ? 'tenantChange' : 'customCloudARMUrlChange', doLogin)
					.catch(console.error);
			} else if (e.affectsConfiguration(getSettingWithPrefix(resourceFilterSetting))) {
				this.updateFilters(true);
			}
		}));

		this.initialize('activation', false, true)
			.catch(console.error);

		if (enableLogging) {
			const outputChannel: OutputChannel = window.createOutputChannel(displayName);
			context.subscriptions.push(outputChannel);
			Logging.setLoggingOptions({
				level: 3 /* Logging.LOGGING_LEVEL.VERBOSE */,
				log: (_level, message, error) => {
					if (message) {
						outputChannel.appendLine(message);
					}
					if (error) {
						outputChannel.appendLine(error.message);
					}
				}
			});
		}
	}

	public async login(trigger: LoginTrigger): Promise<void> {
		let path: CodePath = 'newLogin';
		let environmentName: string = 'uninitialized';
		const cancelSource: CancellationTokenSource = new CancellationTokenSource();

		try {
			const environment: Environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const onlineTask: Promise<void> = checkIsOnline(environment, 2000, cancelSource.token);
			const timerTask: Promise<unknown> = delay(2000, true);

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

			this.setLoggedInStatus();
			const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
			const adfs: boolean = codeFlowLogin.isADFS(environment);
			const useCodeFlow: boolean = trigger !== 'loginWithDeviceCode' && await codeFlowLogin.checkRedirectServer(adfs);
			path = useCodeFlow ? 'newLoginCodeFlow' : 'newLoginDeviceCode';

			// Get the token from logging in (via "code flow" or device code)
			const tokenResponse: TokenResponse = useCodeFlow ? 
				await codeFlowLogin.login(clientId, environment, adfs, tenantId, openUri, async () => {
					const message: string = localize('azure-account.browserDidNotConnect', 'Browser did not connect to local server within 10 seconds. Do you want to try the alternate sign in using a device code instead?');
					const useDeviceCode: string = localize('azure-account.useDeviceCode', 'Use Device Code');
					const response: string | undefined = await window.showInformationMessage(message, useDeviceCode);
					if (response) {
						await commands.executeCommand('azure-account.loginWithDeviceCode');
					}
				}) : 
				await deviceLogin(environment, tenantId);

			// Get the ADAL refresh token (not exposed in MSAL)
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const refreshToken: string = tokenResponse.refreshToken!;

			// If using the common tenant, pass through tokenResponse. Otherwise do some work to get the tokenResponses
			const tokenResponses: TokenResponse[] = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];

			// Save refresh token using keytar
			await storeRefreshToken(environment, refreshToken);
			await this.updateSessions(environment, tokenResponses);
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
			this.updateStatus();
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
		await this.api.waitForLogin();
		// 'Azure' and 'AzureChina' are the old names for the 'AzureCloud' and 'AzureChinaCloud' environments
		const allEnvironmentNames: string[] = staticEnvironmentNames.concat(['Azure', 'AzureChina', 'AzurePPE'])
		for (const name of allEnvironmentNames) {
			await deleteRefreshToken(name);
		}
		await this.clearSessions();
		this.updateStatus();
	}

	public async loginToCloud(): Promise<void> {
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
			const config: WorkspaceConfiguration = workspace.getConfiguration(prefix);
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
					await config.update(cloudSetting, selected.environment.name, getCurrentTarget(config.inspect(cloudSetting)));
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
			const timing: boolean = false;
			const start: number = Date.now();
			await this.loadCache();
			timing && console.log(`loadCache: ${(Date.now() - start) / 1000}s`);
			const environment: Environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
			const storedCreds: string | undefined = await getStoredCredentials(environment, migrateToken);

			timing && console.log(`keytar: ${(Date.now() - start) / 1000}s`);
			if (!storedCreds) {
				throw new AzureLoginError(localize('azure-account.refreshTokenMissing', "Not signed in"));
			}
			await checkIsOnline(environment, 5000);
			this.setLoggedInStatus();


			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let parsedCreds: any;
			let tokenResponse: TokenResponse | undefined;
			try {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				parsedCreds = JSON.parse(storedCreds);
			} catch (_) {
				tokenResponse = await tokenFromRefreshToken(environment, storedCreds, tenantId);
			}

			if (parsedCreds) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const { redirectionUrl, code } = parsedCreds;
				if (!redirectionUrl || !code) {
					throw new AzureLoginError(localize('azure-account.malformedCredentials', "Stored credentials are invalid"));
				}

				tokenResponse = await codeFlowLogin.tokenWithAuthorizationCode(clientId, Environment.AzureCloud, redirectionUrl, tenantId, code);
			}

			if (!tokenResponse) {
				throw new AzureLoginError(localize('azure-account.missingTokenResponse', "Using stored credentials failed"));
			}

			timing && console.log(`tokenFromRefreshToken: ${(Date.now() - start) / 1000}s`);
			// For testing
			if (getSettingValue('testTokenFailure')) {
				throw new AzureLoginError(localize('azure-account.testingAcquiringTokenFailed', "Testing: Acquiring token failed"));
			}
			const tokenResponses: TokenResponse[] = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
			timing && console.log(`tokensFromToken: ${(Date.now() - start) / 1000}s`);
			await this.updateSessions(environment, tokenResponses);
			timing && console.log(`updateSessions: ${(Date.now() - start) / 1000}s`);
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
			this.updateStatus();
		}
	}

	private async loadCache(): Promise<void> {
		const cache: ISubscriptionCache | undefined = this.context.globalState.get<ISubscriptionCache>(cacheKey);
		if (cache) {
			(<IAzureAccountWriteable>this.api).status = 'LoggedIn';
			const sessions = await this.initializeSessions(cache);
			const subscriptions = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateCache(): void {
		if (this.api.status !== 'LoggedIn') {
			void this.context.globalState.update(cacheKey, undefined);
			return;
		}
		const cache: ISubscriptionCache = {
			subscriptions: this.api.subscriptions.map(({ session, subscription }) => ({
				session: {
					environment: session.environment.name,
					userId: session.userId,
					tenantId: session.tenantId
				},
				subscription
			}))
		}
		void this.context.globalState.update(cacheKey, cache);
	}

	private setLoggedInStatus(): void {
		if (this.api.status !== 'LoggedIn') {
			(<IAzureAccountWriteable>this.api).status = 'LoggingIn';
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private updateStatus(): void {
		const status = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (this.api.status !== status) {
			(<IAzureAccountWriteable>this.api).status = status;
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private async initializeSessions(cache: ISubscriptionCache): Promise<Record<string, AzureSession>> {
		const sessions: Record<string, AzureSession> = {};
		for (const { session } of cache.subscriptions) {
			const { environment, userId, tenantId } = session;
			const key = `${environment} ${userId} ${tenantId}`;
			const environments = await getEnvironments();
			const env = environments.find(e => e.name === environment);
			if (!sessions[key] && env) {
				sessions[key] = {
					environment: env,
					userId,
					tenantId,
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					credentials: new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.delayedCache, domain: tenantId }),
					credentials2: new DeviceTokenCredentials2(clientId, tenantId, userId, undefined, env, this.delayedCache)
				};
				this.api.sessions.push(sessions[key]);
			}
		}
		return sessions;
	}

	private async updateSessions(environment: Environment, tokenResponses: TokenResponse[]): Promise<void> {
		// We just signed in so clear out the ADAL token cache
		await clearTokenCache(this.tokenCache);

		// Add the new tokens to the ADAL cache
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}

		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		this.delayedCache.initEnd!();
		const sessions: AzureSession[] = this.api.sessions;
		sessions.splice(0, sessions.length, ...tokenResponses.map<AzureSession>(tokenResponse => ({
			environment,
			userId: tokenResponse.userId!,
			tenantId: tokenResponse.tenantId!,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
			credentials: new DeviceTokenCredentials({ environment: (<any>environment), username: tokenResponse.userId, clientId, tokenCache: this.delayedCache, domain: tokenResponse.tenantId }),
			credentials2: new DeviceTokenCredentials2(clientId, tokenResponse.tenantId, tokenResponse.userId, undefined, environment, this.delayedCache)
		})));
		this.onSessionsChanged.fire();
		/* eslint-enable @typescript-eslint/no-non-null-assertion */
	}

	private async clearSessions(): Promise<void> {
		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.length = 0;
		this.onSessionsChanged.fire();
	}

	private async waitForSubscriptions(): Promise<boolean> {
		if (!(await this.api.waitForLogin())) {
			return false;
		}
		await this.subscriptionsTask;
		return true;
	}

	private initializeSubscriptions(cache: ISubscriptionCache, sessions: Record<string, AzureSession>): AzureSubscription[] {
		const subscriptions: AzureSubscription[] = cache.subscriptions.map<AzureSubscription>(({ session, subscription }) => {
			const { environment, userId, tenantId } = session;
			const key = `${environment} ${userId} ${tenantId}`;
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
		this.updateCache();
		this.onSubscriptionsChanged.fire();
	}

	public async askForLogin(): Promise<boolean | unknown> {
		if (this.api.status === 'LoggedIn') {
			return;
		}
		const login: MessageItem = { title: localize('azure-account.login', "Sign In") };
		const result: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.loginFirst', "You are not signed in. Sign in to continue."), login);
		return result === login && commands.executeCommand('azure-account.login');
	}

	public async selectSubscriptions(): Promise<unknown> {
		if (!(await this.waitForSubscriptions())) {
			return commands.executeCommand('azure-account.askForLogin');
		}

		const config: WorkspaceConfiguration = workspace.getConfiguration(prefix);
		const resourceFilter: string[] = (config.get<string[]>(resourceFilterSetting) || ['all']).slice();
		let changed: boolean = false;

		const subscriptionItemsTask: Promise<ISubscriptionItem[]> = this.subscriptionsTask
			.then(list => this.asSubscriptionItems(list, resourceFilter));
		const source = new CancellationTokenSource();
		const cancellableTask: Promise<ISubscriptionItem[]> = subscriptionItemsTask.then(s => {
			if (!s.length) {
				source.cancel();
				this.noSubscriptionsFound()
					.catch(console.error);
			}
			return s;
		});
		const picks: QuickPickItem[] | undefined = await window.showQuickPick(cancellableTask, { canPickMany: true, placeHolder: 'Select Subscriptions' }, source.token);
		if (picks) {
			if (resourceFilter[0] === 'all') {
				resourceFilter.splice(0, 1);
				for (const subscription of await subscriptionItemsTask) {
					addFilter(resourceFilter, subscription);
				}
			}
			for (const subscription of await subscriptionItemsTask) {
				if (subscription.picked !== (picks.indexOf(subscription) !== -1)) {
					changed = true;
					if (subscription.picked) {
						removeFilter(resourceFilter, subscription);
					} else {
						addFilter(resourceFilter, subscription);
					}
				}
			}
		}

		if (changed) {
			await this.updateConfiguration(config, resourceFilter);
		}
	}

	private async noSubscriptionsFound(): Promise<void> {
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const response: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.noSubscriptionsFound', "No subscriptions were found. Set up your account at https://azure.microsoft.com/en-us/free/."), open);
		if (response === open) {
			void openUri('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account');
		}
	}

	private async loadSubscriptions(): Promise<AzureSubscription[]> {
		const lists: AzureSubscription[][] = await Promise.all(this.api.sessions.map(session => {
			const credentials: TokenCredentialsBase = session.credentials2;
			const client: SubscriptionClient = new SubscriptionClient(credentials, { baseUri: session.environment.resourceManagerEndpointUrl });
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

	private asSubscriptionItems(subscriptions: AzureSubscription[], resourceFilter: string[]): ISubscriptionItem[] {
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

	private updateFilters(configChange: boolean = false): void {
		const resourceFilter: string[] | undefined = getSettingValue(resourceFilterSetting);
		if (configChange && JSON.stringify(resourceFilter) === this.oldResourceFilter) {
			return;
		}
		this.filtersTask = (async () => {
			await this.waitForSubscriptions();
			const subscriptions: AzureSubscription[] = await this.subscriptionsTask;
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters: AzureSubscription[] = getNewFilters(subscriptions, resourceFilter);
			this.api.filters.splice(0, this.api.filters.length, ...newFilters);
			this.onFiltersChanged.fire();
			return this.api.filters;
		})();
	}

	private async waitForLogin(): Promise<boolean> {
		switch (this.api.status) {
			case 'LoggedIn':
				return true;
			case 'LoggedOut':
				return false;
			case 'Initializing':
			case 'LoggingIn':
				return new Promise<boolean>(resolve => {
					const subscription = this.api.onStatusChanged(() => {
						subscription.dispose();
						resolve(this.waitForLogin());
					});
				});
			default:
				const status: never = this.api.status;
				throw new Error(`Unexpected status '${status}'`);
		}
	}

	private async waitForFilters(): Promise<boolean> {
		if (!(await this.waitForSubscriptions())) {
			return false;
		}
		await this.filtersTask;
		return true;
	}
}

export async function tokenFromRefreshToken(environment: Environment, refreshToken: string, tenantId: string, resource?: string): Promise<TokenResponse> {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache: MemoryCache = new MemoryCache();
		// ADAL's authentication context
		const context: AuthenticationContext = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, environment.validateAuthority, tokenCache);
		// Manually get a new token from the given refresh token
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		context.acquireTokenWithRefreshToken(refreshToken, clientId, <any>resource, (err, tokenResponse) => {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), err));
			} else if (tokenResponse.error) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), tokenResponse));
			} else {
				resolve(<TokenResponse>tokenResponse);
			}
		});
	});
}

// Gets all tokens from using `DeviceTokenCredentials2` given the first token response
async function tokensFromToken(environment: Environment, firstTokenResponse: TokenResponse): Promise<TokenResponse[]> {
	// Create ADAL memory cache
	const tokenCache: MemoryCache = new MemoryCache();
	// Add firstTokenResponse to cache using ADAL cache driver
	await addTokenToCache(environment, tokenCache, firstTokenResponse);
	// Get device token credentials from firstTokenResponse
	const credentials: DeviceTokenCredentials2 = new DeviceTokenCredentials2(clientId, undefined, firstTokenResponse.userId, undefined, environment, tokenCache);
	// Create an Azure subscription client from the credentials
	const client: SubscriptionClient = new SubscriptionClient(credentials, { baseUri: environment.resourceManagerEndpointUrl });
	// Get a list of tenants from the subscription client
	const tenants: TenantIdDescription[] = await listAll(client.tenants, client.tenants.list());
	const responses: TokenResponse[] = <TokenResponse[]>(await Promise.all<TokenResponse | null>(tenants.map((tenant) => {
		if (tenant.tenantId === firstTokenResponse.tenantId) {
			// This tenant corresponds to the firstTokenResponse's tenant --> pass it through
			return firstTokenResponse;
		}
		// Use the refresh token to generate a new token
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return tokenFromRefreshToken(environment, firstTokenResponse.refreshToken!, tenant.tenantId!)
			.catch(err => {
				console.error(err instanceof AzureLoginError && err.reason ? err.reason : err);
				return null;
			});
	// Useless filter?
	}))).filter(r => r);
	if (!responses.some(response => response?.tenantId === firstTokenResponse.tenantId)) {
		// The firstTokenResponse wasn't found in the tenants. Add it here
		responses.unshift(firstTokenResponse);
	}
	return responses;
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
