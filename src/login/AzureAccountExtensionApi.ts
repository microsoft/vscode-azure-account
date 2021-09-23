/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, Event } from 'vscode';
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
		this.sendIsLegacyApiTelemetry('waitForFilters', isLegacyApi);

		if (!(await this.waitForSubscriptions())) {
			return false;
		}
		await this.azureLoginHelper.filtersTask;
		return true;
	}

	public async waitForLogin(isLegacyApi?: boolean): Promise<boolean> {
		this.sendIsLegacyApiTelemetry('waitForLogin', isLegacyApi);

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
	}

	public async waitForSubscriptions(isLegacyApi?: boolean): Promise<boolean> {
		this.sendIsLegacyApiTelemetry('waitForSubscriptions', isLegacyApi);

		if (!(await this.waitForLogin())) {
			return false;
		}
		await this.azureLoginHelper.subscriptionsTask;
		return true;
	}

	public createCloudShell(os: OSName, isLegacyApi?: boolean): types.CloudShell {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return createCloudConsole(this, this.azureLoginHelper.reporter, os, isLegacyApi)!;
	}

	private sendIsLegacyApiTelemetry(eventName: string, isLegacyApi?: boolean): void {
		this.azureLoginHelper.reporter.sendSanitizedEvent(eventName, { 'isLegacyApi': String(!!isLegacyApi) });
	}
}
