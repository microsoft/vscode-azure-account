const adal = require('adal-node');
const MemoryCache = adal.MemoryCache;
const AuthenticationContext = adal.AuthenticationContext;
const CacheDriver = require('adal-node/lib/cache-driver');
const createLogContext = require('adal-node/lib/log').createLogContext;

import { DeviceTokenCredentials, AzureEnvironment } from 'ms-rest-azure';
import { SubscriptionClient } from 'azure-arm-resource';
import * as opn from 'opn';
import * as copypaste from 'copy-paste';

import { window, commands, credentials, EventEmitter, MessageItem, ExtensionContext } from 'vscode';
import { AzureLogin, AzureSession, AzureLoginStatus } from './azurelogin.api';

const defaultEnvironment = (<any>AzureEnvironment).Azure;
const commonTenantId = 'common';
const authorityHostUrl = defaultEnvironment.activeDirectoryEndpointUrl;
const clientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const authorityUrl = `${authorityHostUrl}${commonTenantId}`;
const resource = defaultEnvironment.activeDirectoryResourceId;

const credentialsService = 'Azure';
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

interface AzureLoginWriteable extends AzureLogin {
    status: AzureLoginStatus;
}

class AzureLoginError extends Error {
    constructor(message: string, public _reason: any) {
        super(message);
    }
}

export class AzureLoginHelper {

    private onStatusChanged = new EventEmitter<AzureLoginStatus>();
    private onSessionsChanged = new EventEmitter<void>();
    private tokenCache = new MemoryCache();

    constructor(context: ExtensionContext) {
        const subscriptions = context.subscriptions;
        subscriptions.push(commands.registerCommand('vscode-azurelogin.login', () => this.login()));
        subscriptions.push(commands.registerCommand('vscode-azurelogin.logout', () => this.logout()));
        this.initialize()
            .catch(console.error);
    }

    api: AzureLoginWriteable = {
        status: 'Initializing',
        onStatusChanged: this.onStatusChanged.event,
        sessions: [],
        onSessionsChanged: this.onSessionsChanged.event
    };

    async login() {
        try {
            this.beginLoggingIn();
            const deviceLogin = await deviceLogin1();
            const copyAndOpen: MessageItem = { title: 'Copy & Open' };
            const close: MessageItem = { title: 'Close', isCloseAffordance: true };
            const response = await window.showInformationMessage(deviceLogin.message, copyAndOpen, close);
            if (response === copyAndOpen) {
                copypaste.copy(deviceLogin.userCode);
                opn(deviceLogin.verificationUrl);
            }
            const tokenResponse = await deviceLogin2(deviceLogin);
            const refreshToken = tokenResponse.refreshToken;
            const tokenResponses = await tokensFromToken(tokenResponse);
            await credentials.writeSecret(credentialsService, credentialsAccount, refreshToken);
            await this.updateSessions(tokenResponses);
        } finally {
            this.updateStatus();
        }
    }

    async logout() {
        await credentials.deleteSecret(credentialsService, credentialsAccount);
        await this.updateSessions([]);
        this.updateStatus();
    }

    private async initialize() {
        try {
            const refreshToken = await credentials.readSecret(credentialsService, credentialsAccount);
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
            this.api.status = 'LoggingIn';
            this.onStatusChanged.fire(this.api.status);
        }
    }

    private updateStatus() {
        const status = this.api.sessions.length ? 'LoggedIn' : 'LoggedOut';
        if (this.api.status !== status) {
            this.api.status = status;
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
}

async function deviceLogin1(): Promise<DeviceLogin> {
    return new Promise<DeviceLogin>((resolve, reject) => {
        const cache = new MemoryCache();
        const context = new AuthenticationContext(authorityUrl, null, cache);
        context.acquireUserCode(resource, clientId, 'en-us', function (err: any, response: any) {
            if (err) {
                reject(new AzureLoginError('Aquiring user code failed', err));
            } else {
                resolve(response);
            }
        });
    });
}

async function deviceLogin2(deviceLogin: DeviceLogin) {
    return new Promise<TokenResponse>((resolve, reject) => {
        const tokenCache = new MemoryCache();
        const context = new AuthenticationContext(authorityUrl, null, tokenCache);
        context.acquireTokenWithDeviceCode(resource, clientId, deviceLogin, function (err: any, tokenResponse: TokenResponse) {
            if (err) {
                reject(new AzureLoginError('Aquiring token with device code', err));
            } else {
                resolve(tokenResponse);
            }
        });
    });
}

async function tokenFromRefreshToken(refreshToken: string, tenantId = commonTenantId) {
    return new Promise<TokenResponse>((resolve, reject) => {
        const tokenCache = new MemoryCache();
        const context = new AuthenticationContext(`${authorityHostUrl}${tenantId}`, null, tokenCache);
        context.acquireTokenWithRefreshToken(refreshToken, clientId, null, function (err: any, tokenResponse: TokenResponse) {
            if (err) {
                reject(new AzureLoginError('Aquiring token with refresh token', err));
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
    const subscriptionClient = new SubscriptionClient(credentials);
    const tenants = await subscriptionClient.tenants.list();
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
