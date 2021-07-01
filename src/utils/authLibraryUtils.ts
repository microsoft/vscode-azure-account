/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AzureSessionAdal, AzureSessionMsal } from "../azure-account.api";
import { ISubscriptionCacheEntryAdal, ISubscriptionCacheEntryMsal } from "../login/AzureLoginHelper";
import { PublicClientCredential } from "../login/msal/PublicClientCredential";

export function isAzureSessionAdal(session: AzureSessionAdal | AzureSessionMsal): boolean {
	return !isAzureSessionMsal(session);
}

export function isAzureSessionMsal(session: AzureSessionAdal | AzureSessionMsal): boolean {
	return session.credentials instanceof PublicClientCredential;
}

export function getSubscriptionCacheAdal(subscriptionCache: ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[]): ISubscriptionCacheEntryAdal[] {
	const subscriptionCacheAdal: ISubscriptionCacheEntryAdal[] = [];

	for (const subscription of subscriptionCache) {
		if ((<ISubscriptionCacheEntryMsal>subscription).session.accountInfo === undefined) {
			subscriptionCacheAdal.push(<ISubscriptionCacheEntryAdal>subscription);
		}
	}

	return subscriptionCacheAdal;
}

export function getSubscriptionCacheMsal(subscriptionCache: ISubscriptionCacheEntryAdal[] | ISubscriptionCacheEntryMsal[]): ISubscriptionCacheEntryMsal[] {
	const subscriptionCacheMsal: ISubscriptionCacheEntryMsal[] = [];

	for (const subscription of subscriptionCache) {
		if ((<ISubscriptionCacheEntryMsal>subscription).session.accountInfo !== undefined) {
			subscriptionCacheMsal.push(<ISubscriptionCacheEntryMsal>subscription);
		}
	}

	return subscriptionCacheMsal;
}
