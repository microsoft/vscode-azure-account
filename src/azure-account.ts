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
import { SubscriptionClient } from 'azure-arm-resource';
import * as opn from 'opn';
import * as copypaste from 'copy-paste';
import * as nls from 'vscode-nls';
import * as keytarType from 'keytar';
import * as cp from 'child_process';

import { window, commands, EventEmitter, MessageItem, ExtensionContext, workspace, ConfigurationTarget, WorkspaceConfiguration, env, OutputChannel, QuickPickItem } from 'vscode';
import { AzureAccount, AzureSession, AzureLoginStatus, AzureResourceFilter } from './azure-account.api';

const localize = nls.loadMessageBundle();

let keytar: typeof keytarType;
try {
	keytar = require(`${env.appRoot}/node_modules/keytar`)
} catch (e) {
	// Not available.
}

const logVerbose = false;
const defaultEnvironment = (<any>AzureEnvironment).Azure;
const commonTenantId = 'common';
const authorityHostUrl = defaultEnvironment.activeDirectoryEndpointUrl; // Testing: 'https://login.windows-ppe.net/'
const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'; // VSC: 'aebc6443-996d-45c2-90f0-388ff96faa56'
const validateAuthority = true;
const authorityUrl = `${authorityHostUrl}${commonTenantId}`;
const resource = defaultEnvironment.activeDirectoryResourceId;

const credentialsService = 'VSCode Public Azure';
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
	constructor(message: string, public _reason: any) {
		super(message);
	}
}

interface SubscriptionItem extends QuickPickItem {
	type: 'item';
	subscription: AzureResourceFilter;
	selected: boolean;
}

interface SubscriptionActionItem extends QuickPickItem {
	type: 'selectAll' | 'deselectAll' | 'noSubscriptions';
}

export class AzureLoginHelper {

	private onStatusChanged = new EventEmitter<AzureLoginStatus>();
	private onSessionsChanged = new EventEmitter<void>();
	private onFiltersChanged = new EventEmitter<void>();
	private tokenCache = new MemoryCache();
	private oldResourceFilter: string;

	constructor(context: ExtensionContext) {
		const subscriptions = context.subscriptions;
		subscriptions.push(commands.registerCommand('azure-account.login', () => this.login().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.logout', () => this.logout().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.askForLogin', () => this.askForLogin().catch(console.error)));
		subscriptions.push(commands.registerCommand('azure-account.selectSubscriptions', () => this.selectSubscriptions().catch(console.error)));
		subscriptions.push(this.api.onSessionsChanged(() => this.updateFilters().catch(console.error)));
		subscriptions.push(workspace.onDidChangeConfiguration(() => this.updateFilters(true).catch(console.error)));
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
		filters: [],
		onFiltersChanged: this.onFiltersChanged.event,
		waitForFilters: () => this.waitForFilters(),
	};

	async login() {
		try {
			this.beginLoggingIn();
			const deviceLogin = await deviceLogin1();
			await this.showDeviceCodeMessage(deviceLogin);
			const tokenResponse = await deviceLogin2(deviceLogin);
			const refreshToken = tokenResponse.refreshToken;
			const tokenResponses = await tokensFromToken(tokenResponse);
			if (keytar) {
				await keytar.setPassword(credentialsService, credentialsAccount, refreshToken);
			}
			await this.updateSessions(tokenResponses);
		} finally {
			this.updateStatus();
		}
	}

	async showDeviceCodeMessage(deviceLogin: DeviceLogin): Promise<any> {
		const copyAndOpen: MessageItem = { title: localize('azure-account.copyAndOpen', "Copy & Open") };
		const open: MessageItem = { title: localize('azure-account.open', "Open") };
		const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
		const canCopy = process.platform !== 'linux' || (await exitCode('xclip', '-version')) === 0;
		const response = await window.showInformationMessage(deviceLogin.message, canCopy ? copyAndOpen : open, close);
		if (response === copyAndOpen) {
			copypaste.copy(deviceLogin.userCode);
			opn(deviceLogin.verificationUrl);
		} else if (response === open) {
			opn(deviceLogin.verificationUrl);
			await this.showDeviceCodeMessage(deviceLogin);
		} else if (response === close) {
			return Promise.reject(null);
		}
	}

	async logout() {
		await this.api.waitForLogin();
		if (keytar) {
			await keytar.deletePassword(credentialsService, credentialsAccount);
		}
		await this.updateSessions([]);
		this.updateStatus();
	}

	private async initialize() {
		try {
			const refreshToken = keytar && await keytar.getPassword(credentialsService, credentialsAccount);
			if (refreshToken) {
				this.beginLoggingIn();
				const tokenResponse = await tokenFromRefreshToken(refreshToken);
				const tokenResponses = await tokensFromToken(tokenResponse);
				await this.updateSessions(tokenResponses);
			}
		} catch (err) {
			if (!(err instanceof AzureLoginError)) {
				throw err;
			}
		} finally {
			this.updateStatus();
		}
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

	private async updateSessions(tokenResponses: TokenResponse[]) {
		await clearTokenCache(this.tokenCache);
		for (const tokenResponse of tokenResponses) {
			await addTokenToCache(this.tokenCache, tokenResponse);
		}
		const sessions = this.api.sessions;
		sessions.splice(0, sessions.length, ...tokenResponses.map<AzureSession>(tokenResponse => ({
			environment: defaultEnvironment,
			userId: tokenResponse.userId,
			tenantId: tokenResponse.tenantId,
			credentials: new DeviceTokenCredentials({ username: tokenResponse.userId, clientId, tokenCache: this.tokenCache, domain: tokenResponse.tenantId })
		})));
		this.onSessionsChanged.fire();
	}

	private async askForLogin() {
		if (this.api.status === 'LoggedIn') {
			return;
		}
		const login = { title: localize('azure-account.login', "Sign In") };
		const cancel = { title: 'Cancel', isCloseAffordance: true };
		const result = await window.showInformationMessage(localize('azure-account.loginFirst', "Not signed in, sign in first."), login, cancel);
		return result === login && commands.executeCommand('azure-account.login');
	}

	private async selectSubscriptions() {
		if (!(await this.api.waitForLogin())) {
			return commands.executeCommand('azure-account.askForLogin');
		}

		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = azureConfig.get<string[]>('resourceFilter') || ['all'];
		let changed = false;

		const subscriptions = this.loadSubscriptions()
			.then(list => this.asSubscriptionItems(list, resourceFilter));
		const items = subscriptions.then(list => {
			if (!list.length) {
				return [
					<SubscriptionActionItem>{
						type: 'noSubscriptions',
						label: localize('azure-account.noSubscriptionsSignUpFree', "No subscriptions found, select to sign up for a free account."),
						description: '',
					}
				];
			}
			return [
				<SubscriptionActionItem>{
					type: 'selectAll',
					get label() {
						const selected = resourceFilter[0] === 'all' || !list.find(item => {
							const { session, subscription } = item.subscription;
							return resourceFilter.indexOf(`${session.tenantId}/${subscription.subscriptionId}`) === -1;
						});
						return `${getCheckmark(selected)} Select All`;
					},
					description: '',
				},
				<SubscriptionActionItem>{
					type: 'deselectAll',
					get label() {
						return `${getCheckmark(!resourceFilter.length)} Deselect All`;
					},
					description: '',
				},
				...list
			];
		});
		for (let pick = await window.showQuickPick(items); pick; pick = await window.showQuickPick(items)) {
			if (pick.type === 'noSubscriptions') {
				commands.executeCommand('azure-account.createAccount');
				break;
			}
			changed = true;
			switch (pick.type) {
				case 'selectAll':
					if (resourceFilter[0] !== 'all') {
						for (const subscription of await subscriptions) {
							if (subscription.selected) {
								this.removeFilter(resourceFilter, subscription);
							}
						}
						resourceFilter.push('all');
					}
					break;
				case 'deselectAll':
					if (resourceFilter[0] === 'all') {
						resourceFilter.splice(0, 1);
					} else {
						for (const subscription of await subscriptions) {
							if (subscription.selected) {
								this.removeFilter(resourceFilter, subscription);
							}
						}
					}
					break;
				case 'item':
					if (resourceFilter[0] === 'all') {
						resourceFilter.splice(0, 1);
						for (const subscription of await subscriptions) {
							this.addFilter(resourceFilter, subscription);
						}
					}
					if (pick.selected) {
						this.removeFilter(resourceFilter, pick);
					} else {
						this.addFilter(resourceFilter, pick);
					}
					break;
			}
		}

		if (changed) {
			await this.updateConfiguration(azureConfig, resourceFilter);
		}
	}

	private addFilter(resourceFilter: string[], item: SubscriptionItem) {
		const { session, subscription } = item.subscription;
		resourceFilter.push(`${session.tenantId}/${subscription.subscriptionId}`);
		item.selected = true;
	}

	private removeFilter(resourceFilter: string[], item: SubscriptionItem) {
		const { session, subscription } = item.subscription;
		const remove = resourceFilter.indexOf(`${session.tenantId}/${subscription.subscriptionId}`);
		resourceFilter.splice(remove, 1);
		item.selected = false;
	}

	private async loadSubscriptions() {
		const subscriptions: AzureResourceFilter[] = [];
		for (const session of this.api.sessions) {
			const credentials = session.credentials;
			const client = new SubscriptionClient(credentials);
			const list = await listAll(client.subscriptions, client.subscriptions.list());
			const items = list.map(subscription => ({
				session,
				subscription,
			}));
			subscriptions.push(...items);
		}
		subscriptions.sort((a, b) => a.subscription.displayName!.localeCompare(b.subscription.displayName!));
		return subscriptions;
	}

	private asSubscriptionItems(subscriptions: AzureResourceFilter[], resourceFilter: string[]): SubscriptionItem[] {
		return subscriptions.map(subscription => {
			const selected = resourceFilter.indexOf(`${subscription.session.tenantId}/${subscription.subscription.subscriptionId}`) !== -1;
			return <SubscriptionItem>{
				type: 'item',
				get label() {
					let selected = this.selected;
					if (!selected) {
						selected = resourceFilter[0] === 'all';
					}
					return `${getCheckmark(selected)} ${this.subscription.subscription.displayName}`;
				},
				description: subscription.subscription.subscriptionId!,
				subscription,
				selected,
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

	private async updateFilters(configChange = false) {
		const azureConfig = workspace.getConfiguration('azure');
		let resourceFilter = azureConfig.get<string[]>('resourceFilter');
		if (configChange && JSON.stringify(resourceFilter) === this.oldResourceFilter) {
			return;
		}
		this.oldResourceFilter = JSON.stringify(resourceFilter);
		if (resourceFilter && !Array.isArray(resourceFilter)) {
			resourceFilter = [];
		}
		const filters = resourceFilter && resourceFilter.map(s => typeof s === 'string' ? s.split('/') : [])
			.filter(s => s.length === 2)
			.map(([tenantId, subscriptionId]) => ({ tenantId, subscriptionId }));
		const tenantIds = filters && filters.reduce<Record<string, Record<string, boolean>>>((result, filter) => {
			const tenant = result[filter.tenantId] || (result[filter.tenantId] = {});
			tenant[filter.subscriptionId] = true;
			return result;
		}, {});

		const newFilters: AzureResourceFilter[] = [];
		const sessions = tenantIds ? this.api.sessions.filter(session => tenantIds[session.tenantId]) : this.api.sessions;
		for (const session of sessions) {
			const client = new SubscriptionClient(session.credentials);
			const subscriptionIds = tenantIds && tenantIds[session.tenantId];
			const subscriptions = await listAll(client.subscriptions, client.subscriptions.list());
			const filteredSubscriptions = subscriptionIds ? subscriptions.filter(subscription => subscriptionIds[subscription.subscriptionId!]) : subscriptions;
			for (const subscription of filteredSubscriptions) {
				newFilters.push({ session, subscription });
			}
		}
		this.api.filters.splice(0, this.api.filters.length, ...newFilters);
		this.onFiltersChanged.fire();
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
		if (!(await this.api.waitForLogin())) {
			return false;
		}
		// TODO: Wait on some promise.
		if (this.api.filters.length) {
			return true;
		}
		const azureConfig = workspace.getConfiguration('azure');
		const resourceFilter = azureConfig.get<string[]>('resourceFilter');
		if (resourceFilter && !resourceFilter.length) {
			return true;
		}
		return new Promise<boolean>(resolve => {
			const subscription = this.api.onFiltersChanged(() => {
				subscription.dispose();
				resolve(!!this.api.filters.length);
			});
		})
	}
}

async function deviceLogin1(): Promise<DeviceLogin> {
	return new Promise<DeviceLogin>((resolve, reject) => {
		const cache = new MemoryCache();
		const context = new AuthenticationContext(authorityUrl, validateAuthority, cache);
		context.acquireUserCode(resource, clientId, 'en-us', function (err: any, response: any) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.userCodeFailed', "Acquiring user code failed"), err));
			} else {
				resolve(response);
			}
		});
	});
}

async function deviceLogin2(deviceLogin: DeviceLogin) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(authorityUrl, validateAuthority, tokenCache);
		context.acquireTokenWithDeviceCode(resource, clientId, deviceLogin, function (err: any, tokenResponse: TokenResponse) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFailed', "Acquiring token with device code failed"), err));
			} else {
				resolve(tokenResponse);
			}
		});
	});
}

async function tokenFromRefreshToken(refreshToken: string, tenantId = commonTenantId) {
	return new Promise<TokenResponse>((resolve, reject) => {
		const tokenCache = new MemoryCache();
		const context = new AuthenticationContext(`${authorityHostUrl}${tenantId}`, validateAuthority, tokenCache);
		context.acquireTokenWithRefreshToken(refreshToken, clientId, null, function (err: any, tokenResponse: TokenResponse) {
			if (err) {
				reject(new AzureLoginError(localize('azure-account.tokenFromRefreshTokenFailed', "Acquiring token with refresh token failed"), err));
			} else {
				resolve(tokenResponse);
			}
		});
	});
}

async function tokensFromToken(firstTokenResponse: TokenResponse) {
	const tokenResponses = [firstTokenResponse];
	const tokenCache = new MemoryCache();
	await addTokenToCache(tokenCache, firstTokenResponse);
	const credentials = new DeviceTokenCredentials({ username: firstTokenResponse.userId, clientId, tokenCache });
	const client = new SubscriptionClient(credentials);
	const tenants = await listAll(client.tenants, client.tenants.list());
	for (const tenant of tenants) {
		if (tenant.tenantId !== firstTokenResponse.tenantId) {
			const tokenResponse = await tokenFromRefreshToken(firstTokenResponse.refreshToken, tenant.tenantId);
			tokenResponses.push(tokenResponse);
		}
	}
	return tokenResponses;
}

async function addTokenToCache(tokenCache: any, tokenResponse: TokenResponse) {
	return new Promise<any>((resolve, reject) => {
		const driver = new CacheDriver(
			{ _logContext: createLogContext('') },
			`${authorityHostUrl}${tokenResponse.tenantId}`,
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

function getCheckmark(selected: boolean) {
	// Check box: '\u2611' : '\u2610'
	// Check mark: '\u2713' : '\u2003'
	// Check square: '\u25A3' : '\u25A1'
	return selected ? '\u2713' : '\u2003';
}

async function exitCode(command: string, ...args: string[]) {
	return new Promise<number | undefined>(resolve => {
		cp.spawn(command, args)
			.on('error', err => resolve())
			.on('exit', code => resolve(code));
	});
}
