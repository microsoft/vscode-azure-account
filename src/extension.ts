'use strict';

import * as vscode from 'vscode';
import { login, logout, showSubscriptions, useSubscription } from './azurelogin';
import { Reporter } from './telemetry';

export type KeyInfo = { [keyName: string]: string; };
export interface ComposeVersionKeys {
    All: KeyInfo,
    v1: KeyInfo,
    v2: KeyInfo
};

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(new Reporter(context));
    
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.login', login));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.logout', logout));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.showSubscriptions', showSubscriptions));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.useSubscription', useSubscription));
}

export function deactivate() {
}