/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, TreeDataProvider, TreeItem, EventEmitter, TreeItemCollapsibleState, extensions, Extension, commands, window, Disposable } from 'vscode';
import { listAll } from './azure-account';
import { AzureAccount, AzureSession, AzureResourceTypeProvider, AzureResourceNode, AzureResourceViewNode, AzureResourceModel } from './azure-account.api';
import { ResourceModels, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import * as path from 'path';
import * as opn from 'opn';

interface ResourceType {
	extension: Extension<any>;
	id: string;
	kind?: string;
	iconPath?: string;
	provider?: string;
}

function readResourceTypes() {
	const resourceTypes: Record<string, ResourceType> = {};
	for (const extension of extensions.all) {
		const pkg = extension.packageJSON;
		const types = pkg && pkg.contributes && pkg.contributes['azure-account.resourceTypes'] || [];
		types.forEach((t: any) => {
			resourceTypes[t.kind ? `${t.id}:${t.kind}` : t.id] = {
				extension,
				id: t.id,
				kind: t.kind,
				iconPath: t.iconPath && path.join(extension.extensionPath, t.iconPath),
				provider: t.provider
			};
		});
	}
	return resourceTypes;
}

export class ResourceTypeRegistry {
	types: Record<string, ResourceType> = readResourceTypes();
	providerExtensions = Object.keys(this.types)
		.reduce((m, id) => {
			const type = this.types[id];
			if (type.provider) {
				m[type.provider] = type.extension;
			}
			return m;
		}, <Record<string, Extension<any>>>{});
	providers: Record<string, AzureResourceTypeProvider<AzureResourceViewNode>> = {};
	private didChangeTreeData = new EventEmitter<AzureResourceViewNode | undefined | null>();

	onDidChangeTreeData = this.didChangeTreeData.event;

	registerResourceTypeProvider(id: string, provider: AzureResourceTypeProvider<AzureResourceViewNode>) {
		if (this.providers[id]) {
			throw new Error(`A resource type provider with the same id is already registered: ${id}`);
		}
		this.providers[id] = provider;
		if (provider.treeDataProvider.onDidChangeTreeData) {
			const subscription = provider.treeDataProvider.onDidChangeTreeData(node => this.didChangeTreeData.fire(node));
			return { dispose: () => subscription.dispose() };
		}
		return { dispose: () => {} };
	}

	async loadResourceTypeProvider(id: string) {
		await this.providerExtensions[id].activate(); // TODO: Add activation event.
		return this.providers[id];
	}
}

const subscriptionIconPath = path.resolve(__dirname, '../../images/azureSubscription.svg');

function createSubscriptionNode(session: AzureSession, model: SubscriptionModels.Subscription): AzureResourceNode<SubscriptionModels.Subscription> {
	const treeItem = new TreeItem(model.displayName!, TreeItemCollapsibleState.Expanded);
	treeItem.id = model.id;
	treeItem.iconPath = subscriptionIconPath;
	treeItem.contextValue = 'subscription';
	return { provider: undefined, session, model, treeItem };
}

const resourceGroupIconPath = path.resolve(__dirname, '../../images/resourceGroup.svg');

function createResourceGroupNode(session: AzureSession, model: ResourceModels.ResourceGroup): AzureResourceNode<ResourceModels.ResourceGroup> {
	const treeItem = new TreeItem(model.name!, TreeItemCollapsibleState.Collapsed);
	treeItem.id = model.id;
	treeItem.iconPath = resourceGroupIconPath;
	treeItem.contextValue = 'resourceGroup';
	return { provider: undefined, session, model, treeItem };
}

const genericIcon = path.resolve(__dirname, '../../images/genericService.svg');

function createResourceNode(session: AzureSession, model: ResourceModels.GenericResource, resourceType?: ResourceType): AzureResourceNode<ResourceModels.GenericResource> {
	const treeItem = new TreeItem(model.name!);
	treeItem.id = model.id;
	const selector = model.kind ? `${model.type}:${model.kind}` : model.type!;
	treeItem.iconPath = resourceType && resourceType.iconPath || genericIcon;
	treeItem.contextValue = `resource:${selector}`;
	return { provider: undefined, session, model, treeItem };
}

async function loadResourceGroups(node: AzureResourceNode<SubscriptionModels.Subscription>) {
	const client = new ResourceManagementClient(node.session.credentials, node.model.subscriptionId!).resourceGroups;
	const resourceGroups = await listAll(client, client.list());
	return resourceGroups.map(resourceGroup => createResourceGroupNode(node.session, resourceGroup));
}

async function loadResources(node: AzureResourceNode<ResourceModels.GenericResource>, resourceTypeRegistry: ResourceTypeRegistry) {
	const subscriptionId = node.model.id!.split('/')[2];
	const client = new ResourceManagementClient(node.session.credentials, subscriptionId).resourceGroups;
	const resources = await listAll(client, client.listResources(node.model.name!));
	return Promise.all(resources.map(async resource => {
		const selector = resource.kind ? `${resource.type}:${resource.kind}` : resource.type!;
		const resourceType = resourceTypeRegistry.types[selector];
		const child = createResourceNode(node.session, resource, resourceType);
		if (resourceType && resourceType.provider) {
			const provider = await resourceTypeRegistry.loadResourceTypeProvider(resourceType.provider);
			return provider.adaptResourceNode(child);
		}
		return child;
	}));
}

function isResourceNode(node: AzureResourceViewNode): node is AzureResourceNode<AzureResourceModel> {
	return node.provider === undefined;
}

class ResourceTreeProvider implements TreeDataProvider<AzureResourceViewNode> {

	private didChangeTreeData = new EventEmitter<AzureResourceViewNode | undefined | null>();

	onDidChangeTreeData = this.didChangeTreeData.event;

	private subscriptions: Disposable[] = [];

	constructor(private account: AzureAccount, private resourceTypeRegistry: ResourceTypeRegistry) {
		this.subscriptions.push(account.onFiltersChanged(() => this.didChangeTreeData.fire()));
		this.subscriptions.push(this.resourceTypeRegistry.onDidChangeTreeData(node => this.didChangeTreeData.fire(node)));
	}

	async getChildren(element?: AzureResourceViewNode) {
		if (!element) {
			const subscriptions = this.account.filters
				.map(subscription => createSubscriptionNode(subscription.session, subscription.subscription));
			if (subscriptions.length === 1) {
				return loadResourceGroups(subscriptions[0]);
			}
			return subscriptions;
		} else if (!isResourceNode(element)) {
			const provider = await this.resourceTypeRegistry.loadResourceTypeProvider(element.provider!);
			return provider.treeDataProvider.getChildren(element);
		} else if (element.treeItem.contextValue === 'subscription') {
			return loadResourceGroups(element);
		} else if (element.treeItem.contextValue === 'resourceGroup') {
			return loadResources(element, this.resourceTypeRegistry);
		}
		return [];
	}

	async getTreeItem(element: AzureResourceViewNode) {
		if (!isResourceNode(element)) {
			const provider = await this.resourceTypeRegistry.loadResourceTypeProvider(element.provider!);
			return provider.treeDataProvider.getTreeItem(element);
		}
		return element.treeItem;
	}

	dispose() {
		for (const subscription of this.subscriptions) {
			try {
				subscription.dispose();
			} catch (err) {
				console.error(err);
			}
		}
		this.subscriptions.length = 0;
	}
}

function openInPortal(node: AzureResourceNode<AzureResourceModel>) {
	opn(`${node.session.environment.portalUrl}/${node.session.tenantId}/#resource${node.model.id}`);
}

export function activate(context: ExtensionContext, account: AzureAccount, resourceTypeRegistry: ResourceTypeRegistry) {

	const resourceTreeProvider = new ResourceTreeProvider(account, resourceTypeRegistry);

	context.subscriptions.push(
		resourceTreeProvider,
		window.registerTreeDataProvider('azure-account.resourceView', resourceTreeProvider),
		commands.registerCommand('azure-account.openInPortal', openInPortal),
	);
}
