/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext, TreeDataProvider, TreeItem, EventEmitter, TreeItemCollapsibleState, extensions, Extension, commands, window, Disposable } from 'vscode';
import { listAll } from './azure-account';
import { AzureAccount, AzureSession } from './azure-account.api';
import { ResourceModels, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import * as path from 'path';
import * as opn from 'opn';

interface ResourceType {
	extension: Extension<any>;
	id: string;
	kind?: string;
	iconPath: string;
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
				iconPath: path.join(extension.extensionPath, t.iconPath)
			};
		});
	}
	return resourceTypes;
}

type Models = SubscriptionModels.Subscription | ResourceModels.ResourceGroup | ResourceModels.GenericResource;

interface Node<T extends Models> {
	session: AzureSession;
	model: T;
	treeItem: TreeItem;
}

const subscriptionIconPath = path.resolve(__dirname, '../../images/azureSubscription.svg');

function createSubscriptionNode(session: AzureSession, model: SubscriptionModels.Subscription): Node<SubscriptionModels.Subscription> {
	const treeItem = new TreeItem(model.displayName!, TreeItemCollapsibleState.Expanded);
	treeItem.iconPath = subscriptionIconPath;
	treeItem.contextValue = 'subscription';
	return { session, model, treeItem };
}

const resourceGroupIconPath = path.resolve(__dirname, '../../images/resourceGroup.svg');

function createResourceGroupNode(session: AzureSession, model: ResourceModels.ResourceGroup): Node<ResourceModels.ResourceGroup> {
	const treeItem = new TreeItem(model.name!, TreeItemCollapsibleState.Collapsed);
	treeItem.iconPath = resourceGroupIconPath;
	treeItem.contextValue = 'resourceGroup';
	return { session, model, treeItem };
}

const genericIcon = path.resolve(__dirname, '../../images/genericService.svg');

function createResourceNode(session: AzureSession, model: ResourceModels.GenericResource, resourceTypes: Record<string, ResourceType>): Node<ResourceModels.GenericResource> {
	const treeItem = new TreeItem(model.name!);
	const selector = model.kind ? `${model.type}:${model.kind}` : model.type!;
	const t = resourceTypes[selector];
	treeItem.iconPath = t && t.iconPath || genericIcon;
	treeItem.contextValue = `resource:${selector}`;
	return { session, model, treeItem };
}

async function loadResourceGroups(node: Node<SubscriptionModels.Subscription>) {
	const client = new ResourceManagementClient(node.session.credentials, node.model.subscriptionId!).resourceGroups;
	const resourceGroups = await listAll(client, client.list());
	return resourceGroups.map(resourceGroup => createResourceGroupNode(node.session, resourceGroup));
}

async function loadResources(node: Node<ResourceModels.GenericResource>, resourceTypes: Record<string, ResourceType>) {
	const subscriptionId = node.model.id!.split('/')[2];
	const client = new ResourceManagementClient(node.session.credentials, subscriptionId).resourceGroups;
	const resources = await listAll(client, client.listResources(node.model.name!));
	return resources.map(resource => createResourceNode(node.session, resource, resourceTypes));
}

class ResourceTreeProvider implements TreeDataProvider<Node<Models>> {

	private didChangeTreeData = new EventEmitter<Node<Models> | undefined | null>();

	onDidChangeTreeData = this.didChangeTreeData.event;

	private subscriptions: Disposable[] = [];

	constructor(private account: AzureAccount, private resourceTypes: Record<string, ResourceType>) {
		this.subscriptions.push(account.onFiltersChanged(() => this.didChangeTreeData.fire()));
	}

	async getChildren(element?: Node<Models>): Promise<Node<Models>[]> {
		if (!element) {
			const subscriptions = this.account.filters
				.map(subscription => createSubscriptionNode(subscription.session, subscription.subscription));
			if (subscriptions.length === 1) {
				return this.getChildren(subscriptions[0]);
			}
			return subscriptions;
		} else if (element.treeItem.contextValue === 'subscription') {
			return loadResourceGroups(element);
		} else if (element.treeItem.contextValue === 'resourceGroup') {
			return loadResources(element, this.resourceTypes);
		}
		return [];
	}

	getTreeItem(element: Node<Models>) {
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

function openInPortal(node: Node<Models>) {
	opn(`${node.session.environment.portalUrl}/${node.session.tenantId}/#resource${node.model.id}`);
}

export function activate(context: ExtensionContext, account: AzureAccount) {

	const resourceTypes = readResourceTypes();

	const resourceTreeProvider = new ResourceTreeProvider(account, resourceTypes);

	context.subscriptions.push(
		resourceTreeProvider,
		window.registerTreeDataProvider('azure-account.resourceView', resourceTreeProvider),
		commands.registerCommand('azure-account.openInPortal', openInPortal),
	);
}
