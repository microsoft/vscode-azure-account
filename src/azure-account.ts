/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const adal = require('adal-node');
const MemoryCache = adal.MemoryCache;
const AuthenticationContext = adal.AuthenticationContext;
const CacheDriver = require('adal-node/lib/cache-driver');
const createLogContext = require('adal-node/lib/log').createLogContext;

import { DeviceTokenCredentials, AzureEnvironment } from 'ms-rest-azure';
import { SubscriptionClient, SubscriptionModels } from 'azure-arm-resource';
import * as opn from 'opn';
import * as copypaste from 'copy-paste';
import * as nls from 'vscode-nls';
import * as keytarType from 'keytar';
import * as cp from 'child_process';

import { window, commands, EventEmitter, MessageItem, ExtensionContext, workspace, ConfigurationTarget, WorkspaceConfiguration, env, OutputChannel, QuickPickItem } from 'vscode';
import { AzureAccount, AzureSession, AzureLoginStatus, AzureResourceFilter, AzureSubscription } from './azure-account.api';
import { createCloudConsole } from './cloudConsole';
import TelemetryReporter from 'vscode-extension-telemetry';

const localize = nls.loadMessageBundle();

const keytar = getNodeModule<typeof keytarType>('keytar');

function getNodeModule<T>(moduleName: string): T | undefined {
	try {
		return require(`${env.appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return require(`${env.appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}
//List of environment names for user to choose from
function getEnvironmentList(): string[] {
	var list : string[];
	list = ["Azure", "Azure US Government", "Azure China", "Azure Germany"];
	return list;
}

//Returns AzureEnvironment that use has chosen
function getEnvironment(name : string): AzureEnvironment {
	var environmentList : { [selectedname: string]: any} = {};
	environmentList["Azure"] = (<any>AzureEnvironment).Azure;
	environmentList["Azure US Government"] = (<any>AzureEnvironment).AzureUSGovernment;
	environmentList["Azure China"] = (<any>AzureEnvironment).AzureChina;
	environmentList["Azure Germany"] = (<any>AzureEnvironment).AzureGermanCloud;
	if (name) {
		return environmentList[name];
	} else {
		return environmentList["Azure"];
	}
}

const logVerbose = false;
const commonTenantId = 'common';
const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'; // VSC: 'aebc6443-996d-45c2-90f0-388ff96faa56'
const validateAuthority = true;
const credentialsAccount = 'Refresh Token';

interface DeviceLogin {
	userCode: string;
	deviceCode: string;
	verificationUrl: string;
	expiresIn: number;
	interval: number;
	message: string;
}

interface TokenResponse {
	tokenType: string;
	expiresIn: number;
	expiresOn: string;
	resource: string;
	accessToken: string;
	refreshToken: string;
	userId: string;
	isUserIdDisplayable: boolean;
	familyName: string;
	givenName: string;
	oid: string;
	tenantId: string;
	isMRRT: boolean;
	_clientId: string;
	_authority: string;
}

interface AzureAccountWriteable extends AzureAccount {
	status: AzureLoginStatus;
}

class AzureLoginError extends Error {
	constructor(message: string, public reason?: any) {
		super(message);
	}
}

interface SubscriptionItem extends QuickPickItem {
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

class ProxyTokenCache {

	public initEnd?: () => void;
	private init = new Promise(resolve => {
		this.initEnd = resolve;
	});

	constructor(private target: any) {
	}

	remove(entries: any, callback: any) {
		this.target.remove(entries, callback)
	}

	add(entries: any, callback: any) {
		this.target.add(entries, callback)
	}

	find(query: any, callback: any) {
		this.init.then(() => {
			this.target.find(query, callback);
		});
	}
}

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

	constructor(private context: ExtensionContext, private reporter: TelemetryReporter) {
		const subscriptions = context.subscriptions;
		subscriptions.push(commands.registerCommand('azure-account.login', () => this.login().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		subscriptions.push(this.api.onSessionsChanged(() => this.updateSubscriptions().catch(console.error)));
		subscriptions.push(this.api.onSubscriptionsChanged(() => this.updateFilters()));
		subscriptions.push(workspace.onDidChangeConfiguration(() => this.updateFilters(true)));
		this.initialize()
			.catch(console.error);

		if (logVerbose) {
			const outputChannel = window.createOutputChannel('Azure Account');
			subscriptions.push(outputChannel);
			this.enableLogging(outputChannel);
		}
	}

	private enableLogging(channel: OutputChannel) {
		const log = adal.Logging;
		log.setLoggingOptions({
			level: log.LOGGING_LEVEL.VERBOSE,
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

	async login() {
		try {
			this.beginLoggingIn();
			const environment = getSelectedEnvironment();
			const deviceLogin = await deviceLogin1(environment);
			const message = this.showDeviceCodeMessage(deviceLogin);
			const login2 = deviceLogin2(environment, deviceLogin);
			const tokenResponse = await Promise.race([login2, message.then(() => Promise.race([login2, timeout(3 * 60 * 1000)]))]); // 3 minutes
			const refreshToken = tokenResponse.refreshToken;
			const tokenResponses = await tokensFromToken(environment, tokenResponse);
			if (keytar) {
				await keytar.setPassword(getCredentialsService(environment), credentialsAccount, refreshToken);
			}
			await this.updateSessions(environment, tokenResponses);
		} catch (err) {
			if (err instanceof AzureLoginError && err.reason) {
				console.error(err.reason);
			}
			throw err;
		} finally {
			this.updateStatus();
		}
	}

	async showDeviceCodeMessage(deviceLogin: DeviceLogin): Promise<any> {
		const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const canCopy = process.platform !== 'linux' || (await exitCode('xclip', '-version')) === 0;
		const response = await window.showInformationMessage(deviceLogin.message, canCopy ? copyAndOpen : open);
		if (response === copyAndOpen) {
			copypaste.copy(deviceLogin.userCode);
			opn(deviceLogin.verificationUrl);
		} else if (response === open) {
			opn(deviceLogin.verificationUrl);
			await this.showDeviceCodeMessage(deviceLogin);
		} else {
			return Promise.reject(null);
		}
	}

	async logout() {
		await this.api.waitForLogin();
		if (keytar) {
			for (const label of getEnvironmentList()){
				await keytar.deletePassword(getEnvironment(label).name, credentialsAccount);
			}
		}
		await this.clearSessions();
		this.updateStatus();
	}

	private async initialize() {
		try {
			const timing = false;
			const start = Date.now();
			this.loadCache();
			timing && console.log(`loadCache: ${(Date.now() - start) / 1000}s`);
			const environment = getSelectedEnvironment();
			const refreshToken = keytar && await keytar.getPassword(getCredentialsService(environment), credentialsAccount);
			timing && console.log(`keytar: ${(Date.now() - start) / 1000}s`);
			if (!refreshToken) {
				throw new AzureLoginError(localize('azure-account.refreshTokenMissing', "Not signed in"));
			}
			this.beginLoggingIn();
			const tokenResponse = await tokenFromRefreshToken(environment, refreshToken);
			timing && console.log(`tokenFromRefreshToken: ${(Date.now() - start) / 1000}s`);
			// For testing
			if (workspace.getConfiguration('azure').get('testTokenFailure')) {
				throw new AzureLoginError(localize('azure-account.testingAquiringTokenFailed', "Testing: Acquiring token failed"));
			}
			const tokenResponses = await tokensFromToken(environment, tokenResponse);
			timing && console.log(`tokensFromToken: ${(Date.now() - start) / 1000}s`);
			await this.updateSessions(environment, tokenResponses);
			timing && console.log(`updateSessions: ${(Date.now() - start) / 1000}s`);
		} catch (err) {
			await this.clearSessions(); // clear out cached data
			if (!(err instanceof AzureLoginError)) {
				throw err;
			}
		} finally {
			this.updateStatus();
		}
	}

	private loadCache() {
		const cache = this.context.globalState.get<Cache>('cache');
		if (cache) {
			(<AzureAccountWriteable>this.api).status = 'LoggedIn';
			const sessions = this.initializeSessions(cache);
			const subscriptions = this.initializeSubscriptions(cache, sessions);
			this.initializeFilters(subscriptions);
		}
	}

	private updateCache() {
		if (this.api.status !== 'LoggedIn') {
			this.context.globalState.update('cache', undefined);
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
		this.context.globalState.update('cache', cache);
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

	private initializeSessions(cache: Cache) {
		const sessions: Record<string, AzureSession> = {};
		for (const { session } of cache.subscriptions) {
			const { environment, userId, tenantId } = session;
			const key = `${environment} ${userId} ${tenantId}`;
			if (!sessions[key]) {
				sessions[key] = {
					environment: (<any>AzureEnvironment) [environment],
					userId,
					tenantId,
					credentials: new DeviceTokenCredentials({ environment: (<any>AzureEnvironment)[environment], username: userId, clientId, tokenCache: this.delayedCache, domain: tenantId })
				};
				this.api.sessions.push(sessions[key]);
			}
		}
		return sessions;
	}

	private async updateSessions(environment: AzureEnvironment, tokenResponses: TokenResponse[]) {
		await clearTokenCache(this.tokenCache);
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(environment, this.tokenCache, tokenResponse);
		}
		this.delayedCache.initEnd!();
		const sessions = this.api.sessions;
		sessions.splice(0, sessions.length, ...tokenResponses.map<AzureSession>(tokenResponse => ({
			environment,
			userId: tokenResponse.userId,
			tenantId: tokenResponse.tenantId,
			credentials: new DeviceTokenCredentials({ environment: environment, username: tokenResponse.userId, clientId, tokenCache: this.delayedCache, domain: tokenResponse.tenantId })
		})));
		this.onSessionsChanged.fire();
	}

	private async clearSessions() {
		await clearTokenCache(this.tokenCache);
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
		const result = await window.showInformationMessage(localize('azure-account.loginFirst', "Not signed in, sign in first."), login);
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
		const picks = await window.showQuickPick(subscriptions, { canPickMany: true, placeHolder: 'Select Subscriptions' });
		if (picks) {
			if (resourceFilter[0] === 'all') {
				resourceFilter.splice(0, 1);
				for (const subscription of await subscriptions) {
					this.addFilter(resourceFilter, subscription);
				}
			}
			for (const subscription of await subscriptions) {
				if (subscription.picked !== (picks.indexOf(subscription) !== -1)) {
					changed = true;
					if (subscription.picked) {
						this.removeFilter(resourceFilter, subscription);
					} else {
						this.addFilter(resourceFilter, subscription);
					}
				}
			}
		}

		if (changed) {
			await this.updateConfiguration(azureConfig, resourceFilter);
		}
	}

	private addFilter(resourceFilter: string[], item: SubscriptionItem) {
		const { session, subscription } = item.subscription;
		resourceFilter.push(`${session.tenantId}/${subscription.subscriptionId}`);
		item.picked = true;
	}

	private removeFilter(resourceFilter: string[], item: SubscriptionItem) {
		const { session, subscription } = item.subscription;
		const remove = resourceFilter.indexOf(`${session.tenantId}/${subscription.subscriptionId}`);
		resourceFilter.splice(remove, 1);
		item.picked = false;
	}

	private async loadSubscriptions() {
		const lists = await Promise.all(this.api.sessions.map(session => {
			const credentials = session.credentials;
			const client = new SubscriptionClient(credentials, session.environment.resourceManagerEndpointUrl);
			return listAll(client.subscriptions, client.subscriptions.list())
				.then(list => list.map(subscription => ({
					session,
					subscription,
				})));
		}));
		const subscriptions = (<AzureSubscription[]>[]).concat(...lists);
		subscriptions.sort((a, b) => a.subscription.displayName!.localeCompare(b.subscription.displayName!));
		return subscriptions;
	}

	private asSubscriptionItems(subscriptions: AzureSubscription[], resourceFilter: string[]): SubscriptionItem[] {
		return subscriptions.map(subscription => {
			const picked = resourceFilter.indexOf(`${subscription.session.tenantId}/${subscription.subscription.subscriptionId}`) !== -1 || resourceFilter[0] === 'all';
			return <SubscriptionItem>{
				type: 'item',
				label: subscription.subscription.displayName,
				description: subscription.subscription.subscriptionId!,
				subscription,
				picked,
			};
		});
	}

	private async updateConfiguration(azureConfig: WorkspaceConfiguration, resourceFilter: string[]) {
		const resourceFilterConfig = azureConfig.inspect<string[]>('resourceFilter');
		let target = ConfigurationTarget.Global;
		if (resourceFilterConfig) {
			if (resourceFilterConfig.workspaceFolderValue) {
				target = ConfigurationTarget.WorkspaceFolder;
			} else if (resourceFilterConfig.workspaceValue) {
				target = ConfigurationTarget.Workspace;
			} else if (resourceFilterConfig.globalValue) {
				target = ConfigurationTarget.Global;
			}
		}
		await azureConfig.update('resourceFilter', resourceFilter[0] !== 'all' ? resourceFilter : undefined, target);
	}

	private initializeFilters(subscriptions: AzureSubscription[]) {
		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = azureConfig.get<string[]>('resourceFilter');
		this.oldResourceFilter = JSON.stringify(resourceFilter);
		const newFilters = this.newFilters(subscriptions, resourceFilter);
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
			const newFilters = this.newFilters(subscriptions, resourceFilter);
			this.api.filters.splice(0, this.api.filters.length, ...newFilters);
			this.onFiltersChanged.fire();
			return this.api.filters;
		})();
	}

	private newFilters(subscriptions: AzureSubscription[], resourceFilter: string[] | undefined): AzureResourceFilter[] {
		if (resourceFilter && !Array.isArray(resourceFilter)) {
			resourceFilter = [];
		}
		const filters = resourceFilter && resourceFilter.reduce((f, s) => {
			if (typeof s === 'string') {
				f[s] = true;
			}
			return f;
		}, <Record<string, boolean>>{});

		return filters ? subscriptions.filter(s => filters[`${s.session.tenantId}/${s.subscription.subscriptionId}`]) : subscriptions;
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

function getCredentialsService(environment: AzureEnvironment) {
	return environment.name === 'Azure' ? 'VSCode Public Azure' : `VSCode ${environment.name}`;
}

function getSelectedEnvironment(): AzureEnvironment {
	const envConfig = workspace.getConfiguration('azure');
	const envSetting = envConfig.get<string>('environment') || 'Azure';
	return getEnvironment(envSetting);
}

async function deviceLogin1(environment: AzureEnvironment): Promise<DeviceLogin> {
	return new Promise<DeviceLogin>((resolve, reject) => {
		const cache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${commonTenantId}`, validateAuthority, cache);
		context.acquireUserCode(environment.activeDirectoryResourceId, clientId, 'en-us', function (err: any, response: any) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.userCodeFailed', "Acquiring user code failed"), err));
			} else {
				resolve(response);
			}
		});
	});
}

async function deviceLogin2(environment: AzureEnvironment, deviceLogin: DeviceLogin) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${commonTenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithDeviceCode(`${environment.managementEndpointUrl}`, clientId, deviceLogin, function (err: any, tokenResponse: TokenResponse) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), err));
			} else {
				resolve(tokenResponse);
			}
		});
	});
}

export async function tokenFromRefreshToken(environment: AzureEnvironment, refreshToken: string, tenantId = commonTenantId, resource: string | null = null) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${environment.activeDirectoryEndpointUrl}${tenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithRefreshToken(refreshToken, clientId, resource, function (err: any, tokenResponse: TokenResponse) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), err));
			} else {
				resolve(tokenResponse);
			}
		});
	});
}

async function tokensFromToken(environment: AzureEnvironment, firstTokenResponse: TokenResponse) {
	const tokenCache = new MemoryCache();
	await addTokenToCache(environment, tokenCache, firstTokenResponse);
	const credentials = new DeviceTokenCredentials({ username: firstTokenResponse.userId, clientId, tokenCache });
	const client = new SubscriptionClient(credentials);
	const tenants = await listAll(client.tenants, client.tenants.list());
	const responses = await Promise.all<TokenResponse | null>(tenants.map((tenant, i) => {
		if (tenant.tenantId === firstTokenResponse.tenantId) {
			return firstTokenResponse;
		}
		return tokenFromRefreshToken(environment, firstTokenResponse.refreshToken, tenant.tenantId)
			.catch(err => {
				console.error(err instanceof AzureLoginError && err.reason ? err.reason : err);
				return null;
			});
	}));
	return <TokenResponse[]>responses.filter(r => r);
}

async function addTokenToCache(environment: AzureEnvironment, tokenCache: any, tokenResponse: TokenResponse) {
	return new Promise<any>((resolve, reject) => {
		const driver = new CacheDriver(
			{ _logContext: createLogContext('') },
			`${environment.activeDirectoryEndpointUrl}${tokenResponse.tenantId}`,
			tokenResponse.resource,
			clientId,
			tokenCache,
			(entry: any, resource: any, callback: (err: any, response: any) => {}) => {
				callback(null, entry);
			}
		);
		driver.add(tokenResponse, function (err: any) {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

async function clearTokenCache(tokenCache: any) {
	await new Promise<void>((resolve, reject) => {
		tokenCache.find({}, (err: any, entries: any[]) => {
			if (err) {
				reject(err);
			} else {
				tokenCache.remove(entries, (err: any) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			}
		});
	});
}

export interface PartialList<T> extends Array<T> {
	nextLink?: string;
}

export async function listAll<T>(client: { listNext(nextPageLink: string): Promise<PartialList<T>>; }, first: Promise<PartialList<T>>): Promise<T[]> {
	const all: T[] = [];
	for (let list = await first; list.length || list.nextLink; list = list.nextLink ? await client.listNext(list.nextLink) : []) {
		all.push(...list);
	}
	return all;
}

async function exitCode(command: string, ...args: string[]) {
	return new Promise<number | undefined>(resolve => {
		cp.spawn(command, args)
			.on('error', err => resolve())
			.on('exit', code => resolve(code));
	});
}

function timeout(ms: number) {
	return new Promise<never>((resolve, reject) => setTimeout(() => reject('timeout'), ms));
}