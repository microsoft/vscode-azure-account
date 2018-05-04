/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Terminal, Progress, CancellationToken, Disposable, TreeDataProvider, TreeItem } from 'vscode';
import { ServiceClientCredentials } from 'ms-rest';
import { AzureEnvironment } from 'ms-rest-azure';
import { SubscriptionModels, ResourceModels } from 'azure-arm-resource';
import { ReadStream } from 'fs';

export type AzureLoginStatus = 'Initializing' | 'LoggingIn' | 'LoggedIn' | 'LoggedOut';

export interface AzureAccount {
	readonly status: AzureLoginStatus;
	readonly onStatusChanged: Event<AzureLoginStatus>;
	readonly waitForLogin: () => Promise<boolean>;
	readonly sessions: AzureSession[];
	readonly onSessionsChanged: Event<void>;
	readonly subscriptions: AzureSubscription[];
	readonly onSubscriptionsChanged: Event<void>;
	readonly waitForSubscriptions: () => Promise<boolean>;
	readonly filters: AzureResourceFilter[];
	readonly onFiltersChanged: Event<void>;
	readonly waitForFilters: () => Promise<boolean>;
	createCloudShell(os: 'Linux' | 'Windows'): CloudShell;
	registerResourceTypeProvider<T extends AzureResourceViewNode>(id: string, provider: AzureResourceTypeProvider<T>): Disposable;
}

export interface AzureSession {
	readonly environment: AzureEnvironment;
	readonly userId: string;
	readonly tenantId: string;
	readonly credentials: ServiceClientCredentials;
}

export interface AzureSubscription {
	readonly session: AzureSession;
	readonly subscription: SubscriptionModels.Subscription;
}

export type AzureResourceFilter = AzureSubscription;

export type CloudShellStatus = 'Connecting' | 'Connected' | 'Disconnected';

export interface UploadOptions {
	contentLength?: number;
	progress?: Progress<{ message?: string; increment?: number }>;
	token?: CancellationToken;
}

export interface CloudShell {
	readonly status: CloudShellStatus;
	readonly onStatusChanged: Event<CloudShellStatus>;
	readonly waitForConnection: () => Promise<boolean>;
	readonly terminal: Promise<Terminal>;
	readonly session: Promise<AzureSession>;
	readonly uploadFile: (filename: string, stream: ReadStream, options?: UploadOptions) => Promise<void>;
}

export interface AzureResourceViewNode {
	provider: string | undefined;
}

export type AzureResourceModel = SubscriptionModels.Subscription | ResourceModels.ResourceGroup | ResourceModels.GenericResource;

export interface AzureResourceNode<T extends AzureResourceModel> extends AzureResourceViewNode {
	session: AzureSession;
	model: T;
	treeItem: TreeItem;
}

export interface AzureResourceTypeProvider<T extends AzureResourceViewNode> {
	treeDataProvider: TreeDataProvider<T>;
	adaptResourceNode: (node: AzureResourceNode<ResourceModels.GenericResource>) => Promise<T>; // TODO: Reduce flexibility a bit so the resource nodes stay consistent.
}
