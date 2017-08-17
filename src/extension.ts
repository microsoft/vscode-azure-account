import { window, ExtensionContext, commands, credentials, QuickPickItem } from 'vscode';
import { AzureLoginHelper, listAll } from './azurelogin';
import { AzureLogin, AzureSession } from './azurelogin.api';
import { SubscriptionClient, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import * as opn from 'opn';
import WebSiteManagementClient = require('azure-arm-website');

export function activate(context: ExtensionContext) {
    if (!credentials) {
        return; // Proposed API not available.
    }
    const azureLogin = new AzureLoginHelper(context);
    const subscriptions = context.subscriptions;
    subscriptions.push(createStatusBarItem(azureLogin.api));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.createAccount', createAccount));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.showSubscriptions', showSubscriptions(azureLogin.api)));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.showAppServices', showAppServices(azureLogin.api)));
    return azureLogin.api;
}

function createAccount() {
    opn("https://azure.microsoft.com/en-us/free");
}

function createStatusBarItem(api: AzureLogin) {
    const statusBarItem = window.createStatusBarItem();
    function updateStatusBar() {
        switch (api.status) {
            case 'LoggingIn':
                statusBarItem.text = 'Azure: Logging in...';
                statusBarItem.show();
                break;
            case 'LoggedIn':
                statusBarItem.text = `Azure: ${api.sessions[0].userId}`;
                statusBarItem.show();
                break;
            case 'LoggedOut':
                statusBarItem.text = 'Azure: Logged out';
                statusBarItem.show();
                break;
        }
    }
    api.onStatusChanged(updateStatusBar);
    api.onSessionsChanged(updateStatusBar);
    updateStatusBar();
    return statusBarItem;
}

interface SubscriptionItem {
    label: string;
    description: string;
    session: AzureSession;
    subscription: SubscriptionModels.Subscription;
}

function showSubscriptions(api: AzureLogin) {
    return async () => {
        if (api.status !== 'LoggedIn') {
            return commands.executeCommand('vscode-azurelogin.askForLogin');
        }
        const subscriptionItems: SubscriptionItem[] = [];
        for (const session of api.sessions) {
            const credentials = session.credentials;
            const subscriptionClient = new SubscriptionClient(credentials);
            const subscriptions = await listAll(subscriptionClient.subscriptions, subscriptionClient.subscriptions.list());
            subscriptionItems.push(...subscriptions.map(subscription => ({
                label: subscription.displayName || '',
                description: subscription.subscriptionId || '',
                session,
                subscription
            })));
        }
        subscriptionItems.sort((a, b) => a.label.localeCompare(b.label));
        const result = await window.showQuickPick(subscriptionItems);
        if (result) {
            const { session, subscription } = result;
            if (subscription.subscriptionId) {
                const resources = new ResourceManagementClient(session.credentials, subscription.subscriptionId);
                const resourceGroups = await listAll(resources.resourceGroups, resources.resourceGroups.list());
                resourceGroups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                await window.showQuickPick(resourceGroups.map(resourceGroup => ({
                    label: resourceGroup.name || '',
                    description: resourceGroup.location,
                    resourceGroup
                })));
            }
        }
    };
}

function showAppServices(api: AzureLogin) {
    return async () => {
        if (api.status !== 'LoggedIn') {
            return commands.executeCommand('vscode-azurelogin.askForLogin');
        }
        const webAppsPromises: Promise<QuickPickItem[]>[] = [];
        for (const filter of api.filters) {
            const client = new WebSiteManagementClient(filter.session.credentials, filter.subscription.subscriptionId!);
            if (!filter.allResourceGroups) {
                for (const resourceGroup of filter.resourceGroups) {
                    webAppsPromises.push(listAll(client.webApps, client.webApps.listByResourceGroup(resourceGroup.name!))
                        .then(webApps => webApps.map(webApp => ({
                            label: webApp.name || '',
                            description: `${filter.subscription.displayName} > ${resourceGroup.name}`,
                            webApp
                        }))));
                }
            } else {
                webAppsPromises.push(listAll(client.webApps, client.webApps.list())
                    .then(webApps => webApps.map(webApp => {
                        const resourceGroup = filter.resourceGroups.find(resourceGroup => webApp.id!.startsWith(resourceGroup.id!));
                        return {
                            label: webApp.name || '',
                            description: `${filter.subscription.displayName} > ${resourceGroup ? resourceGroup.name : 'New Resource Group'}`,
                            webApp
                        };
                    })));
            }
        }
        const webApps = (<QuickPickItem[]>[]).concat(...(await Promise.all(webAppsPromises)));
        webApps.sort((a, b) => a.label.localeCompare(b.label));
        await window.showQuickPick(webApps);
    }
}

export function deactivate() {
}