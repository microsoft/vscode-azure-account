import { reporter } from './telemetry';
import * as vscode from "vscode";
const { azLogin, azLogout } = require("az-login");

const teleCmdId: string = '';

export async function login() {
    let teleCmdId = 'vscode-azurelogin.login';
    const signInMessage = 'The code {0} has been copied to your clipboard. Click Login and paste in the code to authenticate.';
    
    const { credentials } = await azLogin({ interactiveLoginHandler: (code, message) => {
        vscode.window.showInformationMessage(message);
    }});
    
    if (reporter) {
        reporter.sendTelemetryEvent('command', {
            command: teleCmdId
        });
    }
}

export async function logout() {
    let teleCmdId = 'vscode-azurelogin.logout';

    await azLogout();
    
    if (reporter) {
        reporter.sendTelemetryEvent('command', {
            command: teleCmdId
        });
    }
}
export async function showSubscriptions() {
    let teleCmdId = 'vscode-azurelogin.showSubscriptions';

    if (reporter) {
        reporter.sendTelemetryEvent('command', {
            command: teleCmdId
        });
    }
}
export async function useSubscription(sub: string) {
    let teleCmdId = 'vscode-azurelogin.useSubscription';

    if (reporter) {
        reporter.sendTelemetryEvent('command', {
            command: teleCmdId
        });
    }
}