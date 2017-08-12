import { window, ExtensionContext, commands, credentials } from 'vscode';
import { AzureLoginHelper } from './azurelogin';
import { AzureLogin, AzureSession } from './azurelogin.api';
import { SubscriptionClient, ResourceManagementClient, SubscriptionModels } from 'azure-arm-resource';
import * as opn from 'opn';

export function activate(context: ExtensionContext) {
    if (!credentials) {
        return; // Proposed API not available.
    }
    const azureLogin = new AzureLoginHelper(context);
    const subscriptions = context.subscriptions;
    subscriptions.push(createStatusBarItem(azureLogin.api));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.showSubscriptions', showSubscriptions(azureLogin.api)));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.createAccount', createAccount));
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
            const login = { title: 'Login' };
            const cancel = { title: 'Cancel', isCloseAffordance: true };
            const result = await window.showInformationMessage('Not logged in, log in first.', login, cancel);
            return result === login && commands.executeCommand('vscode-azurelogin.login');
        }
        const subscriptionItems: SubscriptionItem[] = [];
        for (const session of api.sessions) {
            const credentials = session.credentials;
            const subscriptionClient = new SubscriptionClient(credentials);
            const subscriptions = await subscriptionClient.subscriptions.list();
            subscriptionItems.push(...subscriptions.map(subscription => ({
                label: subscription.displayName || '',
                description: subscription.subscriptionId || '',
                session,
                subscription
            })));
        }
        const result = await window.showQuickPick(subscriptionItems);
        if (result) {
            const { session, subscription } = result;
            if (subscription.subscriptionId) {
                const resources = new ResourceManagementClient(session.credentials, subscription.subscriptionId);
                const resourceGroups = await resources.resourceGroups.list();
                await window.showQuickPick(resourceGroups.map(resourceGroup => ({
                    label: resourceGroup.name || '',
                    description: resourceGroup.location,
                    resourceGroup
                })));
            }
        }
    };
}

export function deactivate() {
}