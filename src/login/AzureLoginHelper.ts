/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient, SubscriptionModels } from '@azure/arm-subscriptions';
import { Environment } from '@azure/ms-rest-azure-env';
import { AzureIdentityCredentialAdapter } from '@azure/ms-rest-js';
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { AccountInfo, AuthenticationResult, Configuration, LogLevel, PublicClientApplication, TokenCache } from '@azure/msal-node';
import { Logging, MemoryCache, TokenResponse } from 'adal-node';
import { DeviceTokenCredentials } from 'ms-rest-azure';
import { CancellationTokenSource, commands, ConfigurationTarget, Disposable, EventEmitter, ExtensionContext, MessageItem, OutputChannel, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSessionAdal, AzureSessionMsal, AzureSubscription } from '../azure-account.api';
import { createCloudConsole } from '../cloudConsole/cloudConsole';
import { AuthLibrary, authLibrarySetting, azureCustomCloud, azurePPE, cacheKey, clientId, cloudSetting, commonTenantId, customCloudArmUrlSetting, displayName, extensionPrefix, resourceFilterSetting, scopes, staticEnvironments, tenantSetting } from '../constants';
import { AzureLoginError, getErrorMessage } from '../errors';
import { TelemetryReporter } from '../telemetry';
import { listAll } from '../utils/arrayUtils';
import { getSubscriptionCacheAdal, getSubscriptionCacheMsal, isAzureSessionAdal, isAzureSessionMsal } from '../utils/authLibraryUtils';
import { localize } from '../utils/localize';
import { openUri } from '../utils/openUri';
import { getSettingValue, getSettingWithPrefix } from '../utils/settingUtils';
import { delay } from '../utils/timeUtils';
import { getEnvironments, getSelectedEnvironment, isADFS } from './environments';
import { addFilter, getNewFilters, removeFilter } from './filters';
import { login } from './login';
import { loginWithDeviceCode } from './loginWithDeviceCode';
import { cachePlugin } from './msal/cachePlugin';
import { PublicClientCredential } from './msal/PublicClientCredential';
import { checkRedirectServer } from './server';
import { addTokenToCache, clearTokenCache, deleteRefreshToken, getStoredCredentials, getTokenWithAuthorizationCode, ProxyTokenCache, storeRefreshToken, tokenFromRefreshToken, tokensFromToken } from './tokens';
import { waitUntilOnline } from './waitUntilOnline';

const staticEnvironmentNames: string[] = [
	...staticEnvironments.map(environment => environment.name),
	azureCustomCloud,
	azurePPE
];

const environmentLabels: Record<string, string> = {
	AzureCloud: localize('azure-account.azureCloud', 'Azure'),
	AzureChinaCloud: localize('azure-account.azureChinaCloud', 'Azure China'),
	AzureGermanCloud: localize('azure-account.azureGermanyCloud', 'Azure Germany'),
	AzureUSGovernment: localize('azure-account.azureUSCloud', 'Azure US Government'),
	[azureCustomCloud]: localize('azure-account.azureCustomCloud', 'Azure Custom Cloud'),
	[azurePPE]: localize('azure-account.azurePPE', 'Azure PPE'),
};

const logVerbose: boolean = false;

interface IAzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

export interface ISubscriptionItem extends QuickPickItem {
	subscription: AzureSubscription;
}

export interface ISubscriptionCacheEntryAdal {
	session: {
		environment: string;
		userId: string;
		tenantId: string;
	};
	subscription: SubscriptionModels.Subscription;
}

export interface ISubscriptionCacheEntryMsal {
	session: {
		environment: string;
		userId: string;
		tenantId: string;
		accountInfo: AccountInfo;
	};
	subscription: SubscriptionModels.Subscription;
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

	private tokenCache: MemoryCache = new MemoryCache();
	private delayedTokenCache: ProxyTokenCache = new ProxyTokenCache(this.tokenCache);
	private oldResourceFilter: string = '';
	private doLogin: boolean = false;

	private publicClientApp: PublicClientApplication;

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
		context.subscriptions.push(commands.registerCommand('azure-account.login', () => this.login('login').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => this.login('loginWithDeviceCode').catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.loginToCloud', () => this.loginToCloud().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		context.subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		context.subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
		context.subscriptions.push(workspace.onDidChangeConfiguration(e => {
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

		const msalConfiguration: Configuration = {
			auth: { clientId },
			cache: { cachePlugin }
		};

		if (logVerbose) {
			const outputChannel: OutputChannel = window.createOutputChannel(displayName);
			context.subscriptions.push(outputChannel);

			// Setup ADAL logging
			Logging.setLoggingOptions({
				level: 3 /* Logging.LOGGING_LEVEL.VERBOSE */,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				log: (_level: any, message: any, error: any) => {
					if (message) {
						outputChannel.appendLine(message);
					}
					if (error) {
						outputChannel.appendLine(error);
					}
				}
			});

			// Setup MSAL logging
			msalConfiguration.system = {
				loggerOptions: {
					loggerCallback(_loglevel, message, _containsPii) {
						outputChannel.appendLine(message);
					},
					piiLoggingEnabled: false,
					logLevel: logVerbose ? LogLevel.Verbose : LogLevel.Error,
				}
			}
		}

		this.publicClientApp = new PublicClientApplication(msalConfiguration);
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
			let loginResult: TokenResponse[] | AuthenticationResult;

			if (getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL') {
				const tokenResponse: TokenResponse = <TokenResponse>(useCodeFlow ? 
					await login(clientId, environment, isAdfs, tenantId, openUri, redirectTimeout) : 
					await loginWithDeviceCode(environment, tenantId));

				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const refreshToken: string = tokenResponse.refreshToken!;
				loginResult = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
				await storeRefreshToken(environment, refreshToken);
			} else {
				loginResult = <AuthenticationResult>(await login(clientId, environment, isAdfs, tenantId, openUri, redirectTimeout, this.publicClientApp));
			} 

			await this.updateSessions(environment, loginResult);
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
		await this.api.waitForLogin();
		// 'Azure' and 'AzureChina' are the old names for the 'AzureCloud' and 'AzureChinaCloud' environments
		const allEnvironmentNames: string[] = staticEnvironmentNames.concat(['Azure', 'AzureChina', 'AzurePPE'])
		for (const name of allEnvironmentNames) {
			await deleteRefreshToken(name);
		}
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
			const showTimingLogs: boolean = false;
			const start: number = Date.now();
			await this.loadSubscriptionCache();
			showTimingLogs && console.log(`loadSubscriptionCache: ${(Date.now() - start) / 1000}s`);
			const environment: Environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
			const storedCreds: string | undefined = await getStoredCredentials(environment, migrateToken);

			showTimingLogs && console.log(`keytar: ${(Date.now() - start) / 1000}s`);
			if (!storedCreds) {
				throw new AzureLoginError(localize('azure-account.refreshTokenMissing', "Not signed in"));
			}
			await waitUntilOnline(environment, 5000);
			this.beginLoggingIn();

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let parsedCreds: any;
			let tokenResponse: TokenResponse | undefined;
			let authResult: AuthenticationResult | null = null;

			if (getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL') {
				try {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
					parsedCreds = JSON.parse(storedCreds);
				} catch {
					tokenResponse = await tokenFromRefreshToken(environment, storedCreds, tenantId);
				}

				if (parsedCreds) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
					const { redirectionUrl, code } = parsedCreds;
					if (!redirectionUrl || !code) {
						throw new AzureLoginError(localize('azure-account.malformedCredentials', "Stored credentials are invalid"));
					}

					tokenResponse = await getTokenWithAuthorizationCode(clientId, Environment.AzureCloud, redirectionUrl, tenantId, code);
				}
			} else {
				const msalTokenCache: TokenCache = this.publicClientApp.getTokenCache();
				const accountInfo: AccountInfo[] = await msalTokenCache.getAllAccounts();

				if (accountInfo.length === 1) {
					authResult = await this.publicClientApp.acquireTokenSilent({
						scopes,
						account: accountInfo[0]
					});
				} else {
					throw new Error(localize('azure-account.multipleAccounts', 'Multiple accounts found when reading cache.'));
				}
			}

			if (!tokenResponse && !authResult) {
				throw new AzureLoginError(localize('azure-account.missingTokenResponse', "Using stored credentials failed"));
			}

			showTimingLogs && console.log(`tokenFromRefreshToken: ${(Date.now() - start) / 1000}s`);
			// For testing
			if (workspace.getConfiguration(extensionPrefix).get('testTokenFailure')) {
				throw new AzureLoginError(localize('azure-account.testingAcquiringTokenFailed', "Testing: Acquiring token failed"));
			}

			let loginResult: TokenResponse[] | AuthenticationResult;

			if (tokenResponse) {
				loginResult = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
			} else {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				loginResult = authResult!;
			}

			showTimingLogs && console.log(`tokensFromToken: ${(Date.now() - start) / 1000}s`);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			await this.updateSessions(environment, loginResult);
			showTimingLogs && console.log(`updateSessions: ${(Date.now() - start) / 1000}s`);
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
		const cache = this.context.globalState.get<ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[]>(cacheKey);
		if (cache) {
			(<IAzureAccountWriteable>this.api).status = 'LoggedIn';
			const sessions: Record<string, AzureSessionAdal | AzureSessionMsal> = await this.initializeSessions(cache);
			const subscriptions: AzureSubscription[] = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateSubscriptionCache(): void {
		if (this.api.status !== 'LoggedIn') {
			void this.context.globalState.update(cacheKey, undefined);
			return;
		}

		let cache: ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[];

		if (getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL') {
			cache = this.api.subscriptions
				.filter(({ session }) => isAzureSessionAdal(session))
				.map(({ session, subscription }) => {
					session = <AzureSessionAdal>session;
					return {
						session: {
							environment: session.environment.name,
							userId: session.userId,
							tenantId: session.tenantId,
						},
						subscription
					};
				});
		} else {
			cache = this.api.subscriptions
				.filter(({ session }) => isAzureSessionMsal(session))
				.map(({ session, subscription }) => {
					session = <AzureSessionMsal>session;
					return {
						session: {
							environment: session.environment.name,
							userId: session.userId,
							tenantId: session.tenantId,
							accountInfo: session.accountInfo
						},
						subscription
					};
				});

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

	private async initializeSessions(cache: ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[]): Promise<Record<string, AzureSessionAdal | AzureSessionMsal>> {
		const sessions: Record<string, AzureSessionAdal | AzureSessionMsal> = {};
		const environments: Environment[] = await getEnvironments();

		if (getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL') {
			const subscriptions: ISubscriptionCacheEntryAdal[] = getSubscriptionCacheAdal(cache);

			for (const { session } of subscriptions) {
				const { environment, userId, tenantId } = session;
				// TODO: maybe add auth library setting value to key
				const env: Environment | undefined = environments.find(e => e.name === environment);
				const key: string = this.getKey(environment, userId, tenantId);
				if (!sessions[key] && env) {
					sessions[key] = {
						environment: env,
						userId,
						tenantId,
						// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
						credentials: new DeviceTokenCredentials({ environment: (<any>Environment)[environment], username: userId, clientId, tokenCache: this.delayedTokenCache, domain: tenantId }),
						credentials2: new DeviceTokenCredentials2(clientId, tenantId, userId, undefined, env, this.delayedTokenCache),
					};
					this.api.sessions.push(sessions[key]);
				}
			}
		} else {
			const subscriptions: ISubscriptionCacheEntryMsal[] = getSubscriptionCacheMsal(cache);

			for (const { session } of subscriptions) {
				const { environment, accountInfo } = session;
				const key: string = this.getKey(environment, accountInfo.username, accountInfo.tenantId);
				const env: Environment | undefined = environments.find(e => e.name === environment);
				if (!sessions[key] && env) {
					sessions[key] = {
						environment: env,
						userId: accountInfo.username,
						tenantId: accountInfo.tenantId,
						accountInfo: accountInfo,
						credentials: new PublicClientCredential(this.publicClientApp, accountInfo)	
					};
					this.api.sessions.push(sessions[key]);
				}
			}
		}

		return sessions;
	}

	private async updateSessions(environment: Environment, loginResult: TokenResponse[] | AuthenticationResult): Promise<void> {
		await clearTokenCache(this.tokenCache);
		const sessions: (AzureSessionAdal | AzureSessionMsal)[] = this.api.sessions;

		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		if(Array.isArray(loginResult)) {
			for (const tokenResponse of loginResult) {
				await addTokenToCache(environment, this.tokenCache, tokenResponse);
			}
			this.delayedTokenCache.initEnd!();
			sessions.splice(0, sessions.length, ...loginResult.map<AzureSessionAdal>(tokenResponse => ({
				environment,
				userId: tokenResponse.userId!,
				tenantId: tokenResponse.tenantId!,
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
				credentials: new DeviceTokenCredentials({ environment: (<any>environment), username: tokenResponse.userId, clientId, tokenCache: this.delayedTokenCache, domain: tokenResponse.tenantId }),
				credentials2: new DeviceTokenCredentials2(clientId, tokenResponse.tenantId, tokenResponse.userId, undefined, environment, this.delayedTokenCache),
			})));
		} else {
			sessions.splice(0, sessions.length, <AzureSessionMsal>{
				environment,
				userId: loginResult.account!.username,
				tenantId: loginResult.account!.tenantId,
				accountInfo: loginResult.account!,
				credentials: new PublicClientCredential(this.publicClientApp, loginResult.account!)
			});
		}
		/* eslint-enable @typescript-eslint/no-non-null-assertion */

		this.onSessionsChanged.fire();
	}

	private async clearSessions(): Promise<void> {
		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedTokenCache.initEnd!();
		const sessions: (AzureSessionAdal | AzureSessionMsal)[] = this.api.sessions;
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

	private initializeSubscriptions(cache: ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[], sessions: Record<string, AzureSessionAdal | AzureSessionMsal>): AzureSubscription[] {
		let subscriptions: AzureSubscription[];

		if (getSettingValue<AuthLibrary>(authLibrarySetting) === 'ADAL') {
			const cachedSubscriptions: ISubscriptionCacheEntryAdal[] = getSubscriptionCacheAdal(cache);

			subscriptions = cachedSubscriptions.map(({ session, subscription }) => {
				const { environment, userId, tenantId } = session;
				const key: string = this.getKey(environment, userId, tenantId);
				return {
					session: sessions[key],
					subscription
				};
			});
		} else {
			const cacheSubscriptions: ISubscriptionCacheEntryMsal[] = getSubscriptionCacheMsal(cache);

			subscriptions = cacheSubscriptions.map(({ session, subscription }) => {
				const { environment, accountInfo } = session;
				const key: string = this.getKey(environment, accountInfo.username, accountInfo.tenantId);
				return {
					session: sessions[key],
					subscription
				};
			});
		}

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

	private async loadSubscriptions(): Promise<AzureSubscription[]> {
		const lists: AzureSubscription[][] = await Promise.all(this.api.sessions.map(session => {
			const credentials = isAzureSessionAdal(session) ? 
				(<AzureSessionAdal>session).credentials2 :
				new AzureIdentityCredentialAdapter((<AzureSessionMsal>session).credentials);

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
					const subscription: Disposable = this.api.onStatusChanged(() => {
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

	private getKey(environment: string, userId: string, tenantId: string): string {
		return `${environment} ${userId} ${tenantId}`;
	}
}

export async function redirectTimeout(): Promise<void> {
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
