/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient } from "@azure/arm-subscriptions";
import { AzureSubscription } from "../azure-account.api";
import { cacheKey } from "../constants";
import { ext } from "../extensionVariables";
import { listAll } from "../utils/arrayUtils";
import { AzureSessionInternal } from "./AzureSessionInternal";
import { ISubscriptionCache } from "./subscriptionTypes";

export async function updateSubscriptions(): Promise<void> {
	await ext.loginHelper.api.waitForLogin();
	ext.loginHelper.subscriptionsTask = loadSubscriptions();
	ext.loginHelper.api.subscriptions.splice(0, ext.loginHelper.api.subscriptions.length, ...await ext.loginHelper.subscriptionsTask);

	if (ext.loginHelper.api.status !== 'LoggedIn') {
		void ext.loginHelper.context.globalState.update(cacheKey, undefined);
		return;
	}

	const cache: ISubscriptionCache = {
		subscriptions: ext.loginHelper.api.subscriptions.map(({ session, subscription }) => ({
			session: {
				environment: session.environment.name,
				userId: session.userId,
				tenantId: session.tenantId,
				accountInfo: (<AzureSessionInternal>session).accountInfo
			},
			subscription
		}))
	}
	void ext.loginHelper.context.globalState.update(cacheKey, cache);

	ext.loginHelper.onSubscriptionsChanged.fire();
}

async function loadSubscriptions(): Promise<AzureSubscription[]> {
	const lists: AzureSubscription[][] = await Promise.all(ext.loginHelper.api.sessions.map(session => {
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
