/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Event } from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext } from 'vscode-azureextensionui';
import * as types from '../azure-account.api';
import { createCloudConsole, OSName } from '../cloudConsole/cloudConsole';
import { AzureLoginHelper } from './AzureLoginHelper';

export class AzureAccountExtensionApi implements types.AzureAccountExtensionApi {
	public apiVersion: string = '1.0.0';

	public status: types.AzureLoginStatus = 'Initializing';
	public filters: types.AzureResourceFilter[] = [];
	public sessions: types.AzureSession[] = [];
	public subscriptions: types.AzureSubscription[] = [];

	public onStatusChanged: Event<types.AzureLoginStatus>;
	public onFiltersChanged: Event<void>;
	public onSessionsChanged: Event<void>;
	public onSubscriptionsChanged: Event<void>;

	constructor(public azureLoginHelper: AzureLoginHelper) {
		this.onStatusChanged = azureLoginHelper.onStatusChanged.event;
		this.onFiltersChanged = azureLoginHelper.onFiltersChanged.event;
		this.onSessionsChanged = azureLoginHelper.onSessionsChanged.event;
		this.onSubscriptionsChanged = azureLoginHelper.onSubscriptionsChanged.event;
	}

	public async waitForFilters(isLegacyApi?: boolean): Promise<boolean> {
		return await callWithTelemetryAndErrorHandling('waitForFilters', async (context: IActionContext) => {
			context.telemetry.properties.isLegacyApi = String(!!isLegacyApi);

			if (!(await this.waitForSubscriptions())) {
				return false;
			}
			await this.azureLoginHelper.filtersTask;
			return true;
		}) || false;
	}

	public async waitForLogin(isLegacyApi?: boolean): Promise<boolean> {
		return await callWithTelemetryAndErrorHandling('waitForLogin', (context: IActionContext) => {
			context.telemetry.properties.isLegacyApi = String(!!isLegacyApi);

			switch (this.status) {
				case 'LoggedIn':
					return true;
				case 'LoggedOut':
					return false;
				case 'Initializing':
				case 'LoggingIn':
					return new Promise<boolean>(resolve => {
						const subscription: Disposable = this.onStatusChanged(() => {
							subscription.dispose();
							resolve(this.waitForLogin());
						});
					});
				default:
					const status: never = this.status;
					throw new Error(`Unexpected status '${status}'`);
			}
		}) || false;
	}

	public async waitForSubscriptions(isLegacyApi?: boolean): Promise<boolean> {
		return await callWithTelemetryAndErrorHandling('waitForSubscriptions', async (context: IActionContext) => {
			context.telemetry.properties.isLegacyApi = String(!!isLegacyApi);

			if (!(await this.waitForLogin())) {
				return false;
			}
			await this.azureLoginHelper.subscriptionsTask;
			return true;
		}) || false;
	}

	public createCloudShell(os: OSName): types.CloudShell {
		return <types.CloudShell>createCloudConsole(this, os);
	}
}
