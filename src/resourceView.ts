/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, TreeDataProvider, TreeItem, EventEmitter, TreeItemCollapsibleState, extensions, Extension } from 'vscode';
import { listAll } from './azure-account';
import { AzureAccount, AzureSubscription } from './azure-account.api';
import { ResourceModels, ResourceManagementClient } from 'azure-arm-resource';
import * as path from 'path';

interface ResourceContext {
	account: AzureAccount;
	client: ResourceManagementClient;
	resourceTypes: Record<string, ResourceType>;
}

abstract class GenericItem extends TreeItem {

	constructor(protected context: ResourceContext, label: string, collapsibleState?: TreeItemCollapsibleState) {
		super(label, collapsibleState);
	}

	abstract async getChildren(): Promise<GenericItem[]>;
}

class SubscriptionItem extends GenericItem {

	readonly iconPath = path.resolve(__dirname, '../../images/azureSubscription.svg');

	constructor(context: ResourceContext, subscription: AzureSubscription) {
		super(context, subscription.subscription.displayName!, TreeItemCollapsibleState.Collapsed);
	}

	async getChildren(): Promise<ResourceGroupItem[]> {
		const client = this.context.client.resourceGroups;
		const resourceGroups = await listAll(client, client.list());
		return resourceGroups.map(resourceGroup => new ResourceGroupItem(this.context, resourceGroup));
	}
}

class ResourceGroupItem extends GenericItem {

	readonly iconPath = path.resolve(__dirname, '../../images/ResourceGroup_COLOR.svg');

	constructor(context: ResourceContext, private resourceGroup: ResourceModels.ResourceGroup) {
		super(context, resourceGroup.name!, TreeItemCollapsibleState.Collapsed);
	}

	async getChildren(): Promise<GenericItem[]> {
		const client = this.context.client.resourceGroups;
		const resources = await listAll(client, client.listResources(this.resourceGroup.name!));
		return resources.map(resource => new ResourceItem(this.context, resource));
	}
}

class ResourceItem extends GenericItem {

	readonly contextValue: string;

	constructor(context: ResourceContext, private resource: ResourceModels.GenericResource) {
		super(context, resource.name!);
		this.contextValue = resource.type!;
	}

	get iconPath() {
		const t = this.context.resourceTypes[this.resource.type!];
		return t && t.iconPath;
	}

	async getChildren(): Promise<GenericItem[]> {
		return [];
	}
}

interface ResourceType {
	extension: Extension<any>;
	id: string;
	iconPath: string;
}

export class ResourceTreeProvider implements TreeDataProvider<GenericItem> {
	
	private didChangeTreeData = new EventEmitter<GenericItem | undefined | null>();

	onDidChangeTreeData = this.didChangeTreeData.event;

	private resourceTypes: Record<string, ResourceType> = {};

	constructor(context: ExtensionContext, private account: AzureAccount) {
		context.subscriptions.push(account.onFiltersChanged(() => this.didChangeTreeData.fire()));

		for (const extension of extensions.all) {
			const pkg = extension.packageJSON;
			const types = pkg && pkg.contributes && pkg.contributes['azure-account.resourceTypes'] || [];
			types.forEach((t: any) => {
				this.resourceTypes[t.id] = {
					extension,
					id: t.id,
					iconPath: path.join(extension.extensionPath, t.iconPath)
				};
			});
		}
	}

	async getChildren(element?: GenericItem): Promise<GenericItem[]> {
		if (!element) {
			const subscriptions = this.account.filters
				.map(subscription => new SubscriptionItem({
					account: this.account,
					client: new ResourceManagementClient(subscription.session.credentials, subscription.subscription.subscriptionId!),
					resourceTypes: this.resourceTypes
				}, subscription));
			if (subscriptions.length === 1) {
				return subscriptions[0].getChildren();
			}
			return subscriptions;
		}
		return element.getChildren();
	}

	getTreeItem(element: GenericItem) {
		return element;
	}
}

