/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SubscriptionClient } from "@azure/arm-subscriptions";
import { HttpOperationResponse, RequestPrepareOptions } from "@azure/ms-rest-js";
import { callWithTelemetryAndErrorHandling, IActionContext } from "vscode-azureextensionui";
import { AzureSubscription } from "../azure-account.api";
import { cacheKey } from "../constants";
import { ext } from "../extensionVariables";
import { listAll } from "../utils/arrayUtils";
import { AzureSessionInternal } from "./AzureSessionInternal";
import { SubscriptionTenantCache } from "./subscriptionTypes";
import { TenantIdDescription } from "./TenantIdDescription";

export async function updateSubscriptionsAndTenants(): Promise<void> {
	await callWithTelemetryAndErrorHandling('updateSubscriptionsAndTenants', async (context: IActionContext) => {
		await ext.loginHelper.api.waitForLogin();
		ext.loginHelper.subscriptionsTask = loadSubscriptions(context);
		ext.loginHelper.api.subscriptions.splice(0, ext.loginHelper.api.subscriptions.length, ...await ext.loginHelper.subscriptionsTask);
		ext.loginHelper.tenantsTask = loadTenants(context);

		if (ext.loginHelper.api.status !== 'LoggedIn') {
			void ext.loginHelper.context.globalState.update(cacheKey, undefined);
			return;
		}

		const cache: SubscriptionTenantCache = {
			subscriptions: ext.loginHelper.api.subscriptions.map(({ session, subscription }) => ({
				session: {
					environment: session.environment.name,
					userId: session.userId,
					tenantId: session.tenantId,
					accountInfo: (<AzureSessionInternal>session).accountInfo
				},
				subscription
			})),
			tenants: await ext.loginHelper.tenantsTask
		}
		void ext.loginHelper.context.globalState.update(cacheKey, cache);

		ext.loginHelper.onSubscriptionsChanged.fire();
	});
}

async function loadTenants(context: IActionContext): Promise<TenantIdDescription[]> {
	const knownTenantIds: Set<string> = new Set();
	const knownTenants: TenantIdDescription[] = [];

	for (const session of ext.loginHelper.api.sessions) {
		const client: SubscriptionClient = new SubscriptionClient(session.credentials2, { baseUri: session.environment.resourceManagerEndpointUrl });
		let url: string | undefined = 'https://management.azure.com/tenants?api-version=2020-01-01';

		do {
			const options: RequestPrepareOptions = {
				url,
				method: 'GET'
			};
			const response: HttpOperationResponse = await client.sendRequest(options)

			if (response.parsedBody && 'value' in response.parsedBody) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
				const value: any = response.parsedBody.value;

				if (Array.isArray(value)) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const tenants: any[] = value as any[];
					tenants.forEach(tenant => {
						if ('tenantId' in tenant && 'displayName' in tenant) {
							const sanitizedTenant: TenantIdDescription = tenant as TenantIdDescription;
							if (!knownTenantIds.has(sanitizedTenant.tenantId)) {
								knownTenantIds.add(sanitizedTenant.tenantId);
								knownTenants.push(tenant);
							}
						}
					});

					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					if ('nextLink' in response.parsedBody) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						url = response.parsedBody.nextLink as string | undefined;
					} else {
						url = undefined;
					}
				}
			}
		} while (url);
	}

	context.telemetry.properties.numTenants = knownTenants.length.toString();
	return knownTenants;
}

async function loadSubscriptions(context: IActionContext): Promise<AzureSubscription[]> {
	const lists: AzureSubscription[][] = await Promise.all(ext.loginHelper.api.sessions.map(session => {
		const client: SubscriptionClient = new SubscriptionClient(session.credentials2, { baseUri: session.environment.resourceManagerEndpointUrl });
		return listAll(client.subscriptions, client.subscriptions.list())
			.then(list => list.map(subscription => ({
				session,
				subscription
			})));
	}));
	const subscriptions: AzureSubscription[] = (<AzureSubscription[]>[]).concat(...lists);
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	subscriptions.sort((a, b) => a.subscription.displayName!.localeCompare(b.subscription.displayName!));
	context.telemetry.properties.numSubscriptions = subscriptions.length.toString();
	return subscriptions;
}
