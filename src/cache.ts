/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionModels } from "@azure/arm-subscriptions";
import { Environment } from "@azure/ms-rest-azure-env";
import { TokenResponse } from "adal-node";
import { clientId, credentialsSection } from "./constants";
import { tryGetKeyTar } from "./utils/keytar";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment
const CacheDriver = require('adal-node/lib/cache-driver');
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
const createLogContext = require('adal-node/lib/log').createLogContext;

const keytar = tryGetKeyTar();

export interface ISubscriptionCache {
	subscriptions: {
		session: {
			environment: string;
			userId: string;
			tenantId: string;
		};
		subscription: SubscriptionModels.Subscription;
	}[];
}

export class ProxyTokenCache {
	/* eslint-disable */
	public initEnd?: () => void;
	private initTask: Promise<void> = new Promise<void>(resolve => {
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
		void this.initTask.then(() => {
			this.target.find(query, callback);
		});
	}
	/* eslint-enable */
}


export async function getStoredCredentials(environment: Environment, migrateToken?: boolean): Promise<string | undefined> {
	if (!keytar) {
		return undefined;
	}
	try {
		if (migrateToken) {
			const token = await keytar.getPassword('VSCode Public Azure', 'Refresh Token');
			if (token) {
				if (!await keytar.getPassword(credentialsSection, 'Azure')) {
					await keytar.setPassword(credentialsSection, 'Azure', token);
				}
				await keytar.deletePassword('VSCode Public Azure', 'Refresh Token');
			}
		}
	} catch {
		// ignore
	}
	try {
		return await keytar.getPassword(credentialsSection, environment.name) || undefined;
	} catch {
		// ignore
	}
}

export async function storeRefreshToken(environment: Environment, token: string): Promise<void> {
	if (keytar) {
		try {
			await keytar.setPassword(credentialsSection, environment.name, token);
		} catch (err) {
			// ignore
		}
	}
}

export async function deleteRefreshToken(environmentName: string): Promise<void> {
	if (keytar) {
		try {
			await keytar.deletePassword(credentialsSection, environmentName);
		} catch {
			// ignore
		}
	}
}

/* eslint-disable */
export async function addTokenToCache(environment: Environment, tokenCache: any, tokenResponse: TokenResponse): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const driver = new CacheDriver(
			{ _logContext: createLogContext('') },
			`${environment.activeDirectoryEndpointUrl}${tokenResponse.tenantId}`,
			environment.activeDirectoryResourceId,
			clientId,
			tokenCache,
			(entry: any, _resource: any, callback: (err: any, response: any) => {}) => {
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

export async function clearTokenCache(tokenCache: any): Promise<void> {
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
/* eslint-enable */
