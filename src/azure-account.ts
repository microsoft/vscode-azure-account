/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient, SubscriptionModels } from '@azure/arm-subscriptions';
import { Environment } from '@azure/ms-rest-azure-env';
import { DeviceTokenCredentials as DeviceTokenCredentials2 } from '@azure/ms-rest-nodeauth';
import { Logging, MemoryCache, TokenResponse } from 'adal-node';
import { DeviceTokenCredentials } from 'ms-rest-azure';
import { CancellationTokenSource, commands, ConfigurationTarget, EventEmitter, ExtensionContext, MessageItem, OutputChannel, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription } from './azure-account.api';
import { becomeOnline } from './checkIsOnline';
import { createCloudConsole } from './cloudConsole';
import * as codeFlowLogin from './codeFlowLogin';
import { azureCustomCloud, azurePPE, clientId, commonTenantId, customCloudArmUrlKey, environmentLabels, staticEnvironmentNames, staticEnvironments } from './constants';
import { deviceLogin } from './deviceLogin';
import { getEnvironments, getSelectedEnvironment } from './environments';
import { AzureLoginError, getErrorMessage } from './errors';
import { addFilter, getNewFilters, removeFilter } from './filters';
import { TelemetryReporter } from './telemetry';
import { addTokenToCache, Cache, clearTokenCache, deleteRefreshToken, getStoredCredentials, ProxyTokenCache, storeRefreshToken, tokenFromRefreshToken, tokensFromToken } from './tokens';
import { listAll } from './utils/arrayUtils';
import { localize } from './utils/localize';
import { openUri } from './utils/openUri';
import { delay } from './utils/timeUtils';

const staticEnvironmentNames = [
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

const logVerbose = false;

interface AzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

export interface SubscriptionItem extends QuickPickItem {
	type: 'item';
	subscription: AzureSubscription;
	picked: boolean;
}

interface Cache {
	subscriptions: {
		session: {
			environment: string;
			userId: string;
			tenantId: string;
		};
		subscription: SubscriptionModels.Subscription;
	}[];
}

type LoginTrigger = 'activation' | 'login' | 'loginWithDeviceCode' | 'loginToCloud' | 'cloudChange' | 'tenantChange' | 'customCloudARMUrlChange';
type CodePath = 'tryExisting' | 'newLogin' | 'newLoginCodeFlow' | 'newLoginDeviceCode';

export class AzureLoginHelper {

	private onStatusChanged = new EventEmitter<AzureLoginStatus>();
	private onSessionsChanged = new EventEmitter<void>();

	private subscriptions = Promise.resolve(<AzureSubscription[]>[]);
	private onSubscriptionsChanged = new EventEmitter<void>();

	private filters = Promise.resolve(<AzureResourceFilter[]>[]);

	private onFiltersChanged = new EventEmitter<void>();

	private tokenCache = new MemoryCache();
	private delayedCache = new ProxyTokenCache(this.tokenCache);
	private oldResourceFilter = '';
	private doLogin = false;

	constructor(private context: ExtensionContext, private reporter: TelemetryReporter) {
		const subscriptions = context.subscriptions;
		subscriptions.push(commands.registerCommand('azure-account.login', () => this.login('login').catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.loginWithDeviceCode', () => this.login('loginWithDeviceCode').catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.loginToCloud', () => this.loginToCloud().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
		subscriptions.push(workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('azure.cloud') || e.affectsConfiguration('azure.tenant') || e.affectsConfiguration('azure.customCloud.resourceManagerEndpointUrl')) {
				const doLogin = this.doLogin;
				this.doLogin = false;
				this.initialize(e.affectsConfiguration('azure.cloud') ? 'cloudChange' : e.affectsConfiguration('azure.tenant') ? 'tenantChange' : 'customCloudARMUrlChange', doLogin)
					.catch(console.error);
			} else if (e.affectsConfiguration('azure.resourceFilter')) {
				this.updateFilters(true);
			}
		}));
		this.initialize('activation', false, true)
			.catch(console.error);

		if (logVerbose) {
			const outputChannel = window.createOutputChannel('Azure Account');
			subscriptions.push(outputChannel);
			this.enableLogging(outputChannel);
		}
	}

	private enableLogging(channel: OutputChannel) {
		Logging.setLoggingOptions({
			level: 3 /* Logging.LOGGING_LEVEL.VERBOSE */,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			log: (level: any, message: any, error: any) => {
				if (message) {
					channel.appendLine(message);
				}
				if (error) {
					channel.appendLine(error);
				}
			}
		});
	}

	api: AzureAccount = {
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

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	async login(trigger: LoginTrigger) {
		let path: CodePath = 'newLogin';
		let environmentName = 'uninitialized';
		const cancelSource = new CancellationTokenSource();
		try {
			const environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const online = becomeOnline(environment, 2000, cancelSource.token);
			const timer = delay(2000, true);
			if (await Promise.race([online, timer])) {
				const cancel = { title: localize('azure-account.cancel', "Cancel") };
				await Promise.race([
					online,
					window.showInformationMessage(localize('azure-account.checkNetwork', "You appear to be offline. Please check your network connection."), cancel)
						.then(result => {
							if (result === cancel) {
								throw new AzureLoginError(localize('azure-account.offline', "Offline"));
							}
						})
				]);
				await online;
			}
			this.beginLoggingIn();
			const tenantId = getTenantId();
			const adfs = codeFlowLogin.isADFS(environment);
			const useCodeFlow = trigger !== 'loginWithDeviceCode' && await codeFlowLogin.checkRedirectServer(adfs);
			path = useCodeFlow ? 'newLoginCodeFlow' : 'newLoginDeviceCode';
			const tokenResponse = await (useCodeFlow ? codeFlowLogin.login(clientId, environment, adfs, tenantId, openUri, () => redirectTimeout()) : deviceLogin(environment, tenantId));
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const refreshToken = tokenResponse.refreshToken!;
			const tokenResponses = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
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

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	async sendLoginTelemetry(trigger: LoginTrigger, path: CodePath, cloud: string, outcome: string, message?: string, includeSubscriptions?: boolean) {
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
			event.subscriptions = JSON.stringify((await this.subscriptions).map(s => s.subscription.subscriptionId!));
		}
		this.reporter.sendSanitizedEvent('login', event);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	async logout() {
		await this.api.waitForLogin();
		// 'Azure' and 'AzureChina' are the old names for the 'AzureCloud' and 'AzureChinaCloud' environments
		const allEnvironmentNames: string[] = staticEnvironmentNames.concat(['Azure', 'AzureChina', 'AzurePPE'])
		for (const name of allEnvironmentNames) {
			await deleteRefreshToken(name);
		}
		await this.clearSessions();
		this.updateStatus();
	}

	async loginToCloud(): Promise<void> {
		const current = await getSelectedEnvironment();
		const selected = await window.showQuickPick<{ label: string, description?: string, environment: Environment }>(getEnvironments(true /* includePartial */)
			.then(environments => environments.map(environment => ({
				label: environmentLabels[environment.name],
				description: environment.name === current.name ? localize('azure-account.currentCloud', '(Current)') : undefined,
				environment
			}))), {
			placeHolder: localize('azure-account.chooseCloudToLogin', "Choose cloud to sign in to")
		});

		if (selected) {
			const config = workspace.getConfiguration('azure');
			if (config.get('cloud') !== selected.environment.name) {
				let armUrl;
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
				const tenantId = await window.showInputBox({
					prompt: localize('azure-account.enterTenantId', "Enter the tenant id"),
					placeHolder: localize('azure-account.tenantIdPlaceholder', "Enter your tenant id, or '{0}' for the default tenant", commonTenantId),
					ignoreFocusOut: true});
				if (tenantId) {
					if (armUrl) {
						await config.update(customCloudArmUrlKey, armUrl, getCurrentTarget(config.inspect(customCloudArmUrlKey)));
					}
					await config.update('tenant', tenantId, getCurrentTarget(config.inspect('tenant')));
					// if outside of normal range, set ppe setting
					await config.update('cloud', selected.environment.name, getCurrentTarget(config.inspect('cloud')));
				} else {
					return;
				}
			}
			return this.login('loginToCloud');
		}
	}

	private async initialize(trigger: LoginTrigger, doLogin?: boolean, migrateToken?: boolean) {
		let environmentName = 'uninitialized';
		try {
			const timing = false;
			const start = Date.now();
			await this.loadCache();
			timing && console.log(`loadCache: ${(Date.now() - start) / 1000}s`);
			const environment = await getSelectedEnvironment();
			environmentName = environment.name;
			const tenantId = getTenantId();
			const storedCreds = await getStoredCredentials(environment, migrateToken);

			timing && console.log(`keytar: ${(Date.now() - start) / 1000}s`);
			if (!storedCreds) {
				throw new AzureLoginError(localize('azure-account.refreshTokenMissing', "Not signed in"));
			}
			await becomeOnline(environment, 5000);
			this.beginLoggingIn();

			let tokenResponse: TokenResponse | undefined;
			let parsedCreds;
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
			if (workspace.getConfiguration('azure').get('testTokenFailure')) {
				throw new AzureLoginError(localize('azure-account.testingAcquiringTokenFailed', "Testing: Acquiring token failed"));
			}
			const tokenResponses = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];
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

	private async loadCache() {
		const cache = this.context.globalState.get<Cache>('cache');
		if (cache) {
			(<AzureAccountWriteable>this.api).status = 'LoggedIn';
			const sessions = await this.initializeSessions(cache);
			const subscriptions = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateCache() {
		if (this.api.status !== 'LoggedIn') {
			void this.context.globalState.update('cache', undefined);
			return;
		}
		const cache: Cache = {
			subscriptions: this.api.subscriptions.map(({ session, subscription }) => ({
				session: {
					environment: session.environment.name,
					userId: session.userId,
					tenantId: session.tenantId
				},
				subscription
			}))
		}
		void this.context.globalState.update('cache', cache);
	}

	private beginLoggingIn() {
		if (this.api.status !== 'LoggedIn') {
			(<AzureAccountWriteable>this.api).status = 'LoggingIn';
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private updateStatus() {
		const status = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
		if (this.api.status !== status) {
			(<AzureAccountWriteable>this.api).status = status;
			this.onStatusChanged.fire(this.api.status);
		}
	}

	private async initializeSessions(cache: Cache) {
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

	private async updateSessions(environment: Environment, tokenResponses: TokenResponse[]) {
		await clearTokenCache(this.tokenCache);
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}
		/* eslint-disable @typescript-eslint/no-non-null-assertion */
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
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

	private async clearSessions() {
		await clearTokenCache(this.tokenCache);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.length = 0;
		this.onSessionsChanged.fire();
	}

	private async waitForSubscriptions() {
		if (!(await this.api.waitForLogin())) {
			return false;
		}
		await this.subscriptions;
		return true;
	}

	private initializeSubscriptions(cache: Cache, sessions: Record<string, AzureSession>) {
		const subscriptions = cache.subscriptions.map<AzureSubscription>(({ session, subscription }) => {
			const { environment, userId, tenantId } = session;
			const key = `${environment} ${userId} ${tenantId}`;
			return {
				session: sessions[key],
				subscription
			};
		});
		this.subscriptions = Promise.resolve(subscriptions);
		this.api.subscriptions.push(...subscriptions);
		return subscriptions;
	}

	private async updateSubscriptions() {
		await this.api.waitForLogin();
		this.subscriptions = this.loadSubscriptions();
		this.api.subscriptions.splice(0, this.api.subscriptions.length, ...await this.subscriptions);
		this.updateCache();
		this.onSubscriptionsChanged.fire();
	}

	private async askForLogin() {
		if (this.api.status === 'LoggedIn') {
			return;
		}
		const login = { title: localize('azure-account.login', "Sign In") };
		const result = await window.showInformationMessage(localize('azure-account.loginFirst', "You are not signed in. Sign in to continue."), login);
		return result === login && commands.executeCommand('azure-account.login');
	}

	private async selectSubscriptions() {
		if (!(await this.waitForSubscriptions())) {
			return commands.executeCommand('azure-account.askForLogin');
		}

		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = (azureConfig.get<string[]>('resourceFilter') || ['all']).slice();
		let changed = false;

		const subscriptions = this.subscriptions
			.then(list => this.asSubscriptionItems(list, resourceFilter));
		const source = new CancellationTokenSource();
		const cancellable = subscriptions.then(s => {
			if (!s.length) {
				source.cancel();
				this.noSubscriptionsFound()
					.catch(console.error);
			}
			return s;
		});
		const picks = await window.showQuickPick(cancellable, { canPickMany: true, placeHolder: 'Select Subscriptions' }, source.token);
		if (picks) {
			if (resourceFilter[0] === 'all') {
				resourceFilter.splice(0, 1);
				for (const subscription of await subscriptions) {
					addFilter(resourceFilter, subscription);
				}
			}
			for (const subscription of await subscriptions) {
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
			await this.updateConfiguration(azureConfig, resourceFilter);
		}
	}

	async noSubscriptionsFound(): Promise<void> {
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const response = await window.showInformationMessage(localize('azure-account.noSubscriptionsFound', "No subscriptions were found. Set up your account at https://azure.microsoft.com/en-us/free/."), open);
		if (response === open) {
			void openUri('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account');
		}
	}

	private async loadSubscriptions() {
		const lists = await Promise.all(this.api.sessions.map(session => {
			const credentials = session.credentials2;
			const client = new SubscriptionClient(credentials, { baseUri: session.environment.resourceManagerEndpointUrl });
			return listAll(client.subscriptions, client.subscriptions.list())
				.then(list => list.map(subscription => ({
					session,
					subscription,
				})));
		}));
		const subscriptions = (<AzureSubscription[]>[]).concat(...lists);
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		subscriptions.sort((a, b) => a.subscription.displayName!.localeCompare(b.subscription.displayName!));
		return subscriptions;
	}

	private asSubscriptionItems(subscriptions: AzureSubscription[], resourceFilter: string[]): SubscriptionItem[] {
		return subscriptions.map(subscription => {
			const picked = resourceFilter.indexOf(`${subscription.session.tenantId}/${subscription.subscription.subscriptionId}`) !== -1 || resourceFilter[0] === 'all';
			return <SubscriptionItem>{
				type: 'item',
				label: subscription.subscription.displayName,
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				description: subscription.subscription.subscriptionId!,
				subscription,
				picked,
			};
		});
	}

	private async updateConfiguration(azureConfig: WorkspaceConfiguration, resourceFilter: string[]) {
		const resourceFilterConfig = azureConfig.inspect<string[]>('resourceFilter');
		const target = getCurrentTarget(resourceFilterConfig);
		await azureConfig.update('resourceFilter', resourceFilter[0] !== 'all' ? resourceFilter : undefined, target);
	}

	private initializeFilters(subscriptions: AzureSubscription[]) {
		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = azureConfig.get<string[]>('resourceFilter');
		this.oldResourceFilter = JSON.stringify(resourceFilter);
		const newFilters = getNewFilters(subscriptions, resourceFilter);
		this.filters = Promise.resolve(newFilters);
		this.api.filters.push(...newFilters);
	}

	private updateFilters(configChange = false) {
		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = azureConfig.get<string[]>('resourceFilter');
		if (configChange && JSON.stringify(resourceFilter) === this.oldResourceFilter) {
			return;
		}
		this.filters = (async () => {
			await this.waitForSubscriptions();
			const subscriptions = await this.subscriptions;
			this.oldResourceFilter = JSON.stringify(resourceFilter);
			const newFilters = getNewFilters(subscriptions, resourceFilter);
			this.api.filters.splice(0, this.api.filters.length, ...newFilters);
			this.onFiltersChanged.fire();
			return this.api.filters;
		})();
	}

	private async waitForLogin() {
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

	private async waitForFilters() {
		if (!(await this.waitForSubscriptions())) {
			return false;
		}
		await this.filters;
		return true;
	}
}

function getTenantId() {
	const envConfig = workspace.getConfiguration('azure');
	return envConfig.get<string>('tenant') || commonTenantId;
}

async function redirectTimeout() {
	const response = await window.showInformationMessage('Browser did not connect to local server within 10 seconds. Do you want to try the alternate sign in using a device code instead?', 'Use Device Code');
	if (response) {
		await commands.executeCommand('azure-account.loginWithDeviceCode');
	}
}

function getCurrentTarget(config: { key: string; defaultValue?: unknown; globalValue?: unknown; workspaceValue?: unknown, workspaceFolderValue?: unknown } | undefined) {
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
