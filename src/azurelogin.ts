const adal = require('adal-node');
const MemoryCache = adal.MemoryCache;
const AuthenticationContext = adal.AuthenticationContext;
const CacheDriver = require('adal-node/lib/cache-driver');
const createLogContext = require('adal-node/lib/log').createLogContext;

import { DeviceTokenCredentials } from 'ms-rest-azure';
import * as opn from 'opn';
import * as copypaste from 'copy-paste';

import { window, commands, credentials, EventEmitter, MessageItem, ExtensionContext } from 'vscode';
import { AzureLogin, AzureAccount } from './azurelogin.api';

const commonTenant = 'common';
const authorityHostUrl = 'https://login.microsoftonline.com';
const clientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const authorityUrl = `${authorityHostUrl}/${commonTenant}`;
const resource = 'https://management.core.windows.net/';

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

class AzureLoginError extends Error {
    constructor(message: string, public _reason: any) {
        super(message);
    }
}

export class AzureLoginHelper {

    private onAccountChanged = new EventEmitter<AzureAccount | undefined>();
    private tokenCache = new MemoryCache();

    constructor(context: ExtensionContext) {
        const subscriptions = context.subscriptions;
        subscriptions.push(commands.registerCommand('vscode-azurelogin.login', () => this.login()));
        subscriptions.push(commands.registerCommand('vscode-azurelogin.logout', () => this.logout()));
        this.initialize()
            .catch(console.error);
    }

    api: AzureLogin = {
        account: undefined,
        onAccountChanged: this.onAccountChanged.event
    };

    async login() {
        const deviceLogin = await this.deviceLogin1();
        const copyAndOpen: MessageItem = { title: 'Copy & Open' };
        const close: MessageItem = { title: 'Close', isCloseAffordance: true };
        const response = await window.showInformationMessage(deviceLogin.message, copyAndOpen, close);
        if (response === copyAndOpen) {
            copypaste.copy(deviceLogin.userCode);
            opn(deviceLogin.verificationUrl);
        }
        const tokenResponse = await this.deviceLogin2(deviceLogin);
        const refreshToken = tokenResponse.refreshToken;
        await credentials.writeSecret(credentialsService, credentialsAccount, refreshToken);
        this.update(tokenResponse);
    }

    async logout() {
        await credentials.deleteSecret(credentialsService, credentialsAccount);
        this.update(undefined);
    }

    private async initialize() {
        try {
            const refreshToken = await credentials.readSecret(credentialsService, credentialsAccount);
            if (refreshToken) {
                const tokenResponse = await this.tokenFromRefreshToken(refreshToken);
                this.update(tokenResponse);
                return;
            }
        } catch (err) {
            if (!(err instanceof AzureLoginError)) {
                throw err;
            }
        }
        this.update(undefined);
    }

    private async update(tokenResponse: TokenResponse | undefined) {
        await this.clearTokenCache();
        if (tokenResponse) {
            (<any>this.api).account = <AzureAccount>{
                oid: tokenResponse.oid,
                userId: tokenResponse.userId,
                tenantId: tokenResponse.tenantId,
                credentials: new DeviceTokenCredentials({ username: tokenResponse.userId, clientId, tokenCache: this.tokenCache })
            };
            this.addTokenToCache(tokenResponse);
        } else {
            (<any>this.api).account = undefined;
        }
        this.onAccountChanged.fire(this.api.account);
    }

    private async deviceLogin1(): Promise<DeviceLogin> {
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

    private async deviceLogin2(deviceLogin: any): Promise<TokenResponse> {
        return new Promise<TokenResponse>((resolve, reject) => {
            const cache = new MemoryCache();
            const context = new AuthenticationContext(authorityUrl, null, cache);
            context.acquireTokenWithDeviceCode(resource, clientId, deviceLogin, function (err: any, tokenResponse: any) {
                if (err) {
                    reject(new AzureLoginError('Aquiring token with device code', err));
                } else {
                    resolve(tokenResponse);
                }
            });
        });
    }

    private async tokenFromRefreshToken(refreshToken: string): Promise<TokenResponse> {
        return new Promise<TokenResponse>((resolve, reject) => {
            const cache = new MemoryCache();
            const context = new AuthenticationContext(authorityUrl, null, cache);
            context.acquireTokenWithRefreshToken(refreshToken, clientId, null, function (err: any, tokenResponse: any) {
                if (err) {
                    reject(new AzureLoginError('Aquiring token with refresh token', err));
                } else {
                    resolve(tokenResponse);
                }
            });
        });
    }

    private async addTokenToCache(tokenResponse: TokenResponse) {
        return new Promise<any>((resolve, reject) => {
            const driver = new CacheDriver(
                { _logContext: createLogContext('') },
                `${authorityHostUrl}/${tokenResponse.tenantId}`,
                tokenResponse.resource,
                clientId,
                this.tokenCache,
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

    private async clearTokenCache() {
        await new Promise<void>((resolve, reject) => {
            this.tokenCache.find({}, (err: any, entries: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    this.tokenCache.remove(entries, (err: any) => {
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
}