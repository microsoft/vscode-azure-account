import { window, ExtensionContext, commands } from 'vscode';
import { AzureLoginHelper } from './azurelogin';
import { AzureLogin } from './azurelogin.api';
import * as arm from 'azure-arm-resource';

export function activate(context: ExtensionContext) {
    const azureLogin = new AzureLoginHelper(context);
    const subscriptions = context.subscriptions;
    subscriptions.push(createStatusBarItem(azureLogin.api));
    subscriptions.push(commands.registerCommand('vscode-azurelogin.showSubscriptions', showSubscriptions(azureLogin.api)));
    return azureLogin.api;
}

function createStatusBarItem(api: AzureLogin) {
    const statusBarItem = window.createStatusBarItem();
    api.onAccountChanged(account => {
        statusBarItem.text = account ? `Azure: ${account.userId}` : 'Azure: Logged out';
    });
    statusBarItem.text = 'Azure: Initializing...';
    statusBarItem.show();
    return statusBarItem;
}

function showSubscriptions(api: AzureLogin) {
    return async () => {
        if (!api.account) {
            const login = { title: 'Login' };
            const cancel = { title: 'Cancel', isCloseAffordance: true };
            const result = await window.showInformationMessage('Not logged in, log in first.', login, cancel);
            return result === login && commands.executeCommand('vscode-azurelogin.login');
        }
        const credentials = api.account.credentials;
        const subscriptionClient = new arm.SubscriptionClient(credentials);
        const subscriptions = await subscriptionClient.subscriptions.list();
        const result = await window.showQuickPick(subscriptions.map(subscription => ({
            label: subscription.displayName || '',
            description: subscription.subscriptionId || '',
            subscription
        })));
        if (result) {
            const { subscription } = result;
            if (subscription.subscriptionId) {
                const resources = new arm.ResourceManagementClient(credentials, subscription.subscriptionId);
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