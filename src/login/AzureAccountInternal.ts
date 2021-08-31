/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource, commands, ConfigurationTarget, Disposable, Event, MessageItem, QuickPickItem, window, workspace, WorkspaceConfiguration } from 'vscode';
import { AzureAccount, AzureLoginStatus, AzureResourceFilter, AzureSession, AzureSubscription, CloudShell } from '../azure-account.api';
import { extensionPrefix, resourceFilterSetting } from '../constants';
import { TelemetryReporter } from '../telemetry';
import { localize } from '../utils/localize';
import { openUri } from '../utils/openUri';
import { AzureLoginHelperTasks, AzureLoginStatusObj, ISubscriptionItem } from './AzureLoginHelper';
import { addFilter, removeFilter } from './filters';
import { getCurrentTarget } from './getCurrentTarget';

export class AzureAccountInternal implements AzureAccount {
	public apiVersion: string = '0.1.0';
	public waitForLogin: () => Promise<boolean>;
	public waitForSubscriptions: () => Promise<boolean>;
	public waitForFilters: () => Promise<boolean>;

	constructor(
		public onStatusChanged: Event<AzureLoginStatus>,
		public onSessionsChanged: Event<void>,
		public onSubscriptionsChanged: Event<void>,
		public onFiltersChanged: Event<void>,
		public sessions: (AzureSession)[],
		public subscriptions: (AzureSubscription)[],
		public filters: (AzureResourceFilter)[],
		public createCloudShell: (os: 'Linux' | 'Windows') => CloudShell,
		public isLegacyApi: boolean,
		private tasks: AzureLoginHelperTasks,
		private statusObj: AzureLoginStatusObj,
		private reporter: TelemetryReporter
	) {
		this.waitForLogin = async () => {
			this.sendIsLegacyApiTelemetry('waitForLogin');

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
		};

		this.waitForSubscriptions = async () => {
			this.sendIsLegacyApiTelemetry('waitForSubscriptions');

			if (!(await this.waitForLogin())) {
				return false;
			}
			await this.tasks.subscriptions;
			return true;
		};

		this.waitForFilters = async () => {
			this.sendIsLegacyApiTelemetry('waitForFilters');

			if (!(await this.waitForSubscriptions())) {
				return false;
			}
			await this.tasks.filters;
			return true;
		};
	}

	public get status(): AzureLoginStatus {
		return this.statusObj.status;
	}

	public set status(newStatus: AzureLoginStatus) {
		this.statusObj.status = newStatus;
	}

	public async selectSubscriptions(): Promise<unknown> {
		if (!(await this.waitForSubscriptions())) {
			return commands.executeCommand('azure-account.askForLogin');
		}

		const azureConfig: WorkspaceConfiguration = workspace.getConfiguration(extensionPrefix);
		const resourceFilter: string[] = (azureConfig.get<string[]>(resourceFilterSetting) || ['all']).slice();
		let filtersChanged: boolean = false;

		const subscriptions = this.tasks.subscriptions
			.then(list => getSubscriptionItems(list, resourceFilter));
		const source: CancellationTokenSource = new CancellationTokenSource();
		const cancellable: Promise<ISubscriptionItem[]> = subscriptions.then(s => {
			if (!s.length) {
				source.cancel();
				noSubscriptionsFound()
					.catch(console.error);
			}
			return s;
		});
		const picks: QuickPickItem[] | undefined = await window.showQuickPick(cancellable, { canPickMany: true, placeHolder: 'Select Subscriptions' }, source.token);
		if (picks) {
			if (resourceFilter[0] === 'all') {
				resourceFilter.splice(0, 1);
				for (const subscription of await subscriptions) {
					addFilter(resourceFilter, subscription);
				}
			}
			for (const subscription of await subscriptions) {
				if (subscription.picked !== (picks.indexOf(subscription) !== -1)) {
					filtersChanged = true;
					if (subscription.picked) {
						removeFilter(resourceFilter, subscription);
					} else {
						addFilter(resourceFilter, subscription);
					}
				}
			}
		}

		if (filtersChanged) {
			await updateConfiguration(azureConfig, resourceFilter);
		}
	}

	private sendIsLegacyApiTelemetry(eventName: string): void {
		this.reporter.sendSanitizedEvent(eventName, { 'isLegacyApi': String(!!this.isLegacyApi) });
	}
}

async function updateConfiguration(azureConfig: WorkspaceConfiguration, resourceFilter: string[]): Promise<void> {
	const resourceFilterConfig = azureConfig.inspect<string[]>(resourceFilterSetting);
	const target: ConfigurationTarget = getCurrentTarget(resourceFilterConfig);
	await azureConfig.update(resourceFilterSetting, resourceFilter[0] !== 'all' ? resourceFilter : undefined, target);
}

async function noSubscriptionsFound(): Promise<void> {
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const response: MessageItem | undefined = await window.showInformationMessage(localize('azure-account.noSubscriptionsFound', "No subscriptions were found. Set up your account at https://azure.microsoft.com/en-us/free/."), open);
	if (response === open) {
		void openUri('https://azure.microsoft.com/en-us/free/?utm_source=campaign&utm_campaign=vscode-azure-account&mktingSource=vscode-azure-account');
	}
}

function getSubscriptionItems(subscriptions: AzureSubscription[], resourceFilter: string[]): ISubscriptionItem[] {
	return subscriptions.map(subscription => {
		const picked: boolean = resourceFilter.indexOf(`${subscription.session.tenantId}/${subscription.subscription.subscriptionId}`) !== -1 || resourceFilter[0] === 'all';
		return <ISubscriptionItem>{
			label: subscription.subscription.displayName,
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			description: subscription.subscription.subscriptionId!,
			subscription,
			picked,
		};
	});
}
