/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window, commands, MessageItem } from 'vscode';
import { AzureAccount, AzureSession } from './azure-account.api';
import { getUserSettings, provisionConsole, Errors, resetConsole } from './cloudConsoleLauncher';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as opn from 'opn';

const localize = nls.loadMessageBundle();

export interface OS {
	id: string;
	shellName: string;
	otherOS: OS;
}

export const OSes: Record<string, OS> = {
	Linux: {
		id: 'linux',
		shellName: localize('azure-account.bash', "Bash"),
		get otherOS() { return OSes.Windows; },
	},
	Windows: {
		id: 'windows',
		shellName: localize('azure-account.powershell', "PowerShell"),
		get otherOS() { return OSes.Linux; },
	}
};

export function openCloudConsole(api: AzureAccount, os: OS) {
	return () => {
		return (async function retry(): Promise<any> {
			if (!(await api.waitForLogin())) {
				return commands.executeCommand('azure-account.askForLogin');
			}

			const tokens = await Promise.all(api.sessions.map(session => acquireToken(session)));
			const result = await findUserSettings(tokens);
			if (!result) {
				return requiresSetUp();
			}

			let consoleUri: string;
			const armEndpoint = result.token.session.environment.resourceManagerEndpointUrl;
			const inProgress = delayed(() => window.showInformationMessage(localize('azure-account.provisioningInProgress', "Provisioning a Cloud Shell may take a few seconds.")), 2000);
			try {
				consoleUri = await provisionConsole(result.token.accessToken, armEndpoint, result.userSettings, os.id);
				inProgress.cancel();
			} catch (err) {
				inProgress.cancel();
				if (err && err.message === Errors.DeploymentOsTypeConflict) {
					return deploymentConflict(retry, os, result.token.accessToken, armEndpoint);
				}
				throw err;
			}

			// TODO: How to update the access token when it expires?
			const isWindows = process.platform === 'win32';
			const shellPath = isWindows ? 'node.exe' : 'node';
			let modulePath = path.join(__dirname, 'cloudConsoleLauncher');
			if (isWindows) {
				modulePath = modulePath.replace(/\\/g, '\\\\');
			}
			window.createTerminal({
				name: localize('azure-account.cloudConsole', "Cloud Shell"),
				shellPath, // process.argv0, // TODO
				shellArgs: [
					'-e',
					`require('${modulePath}').main()`,
				],
				env: {
					CLOUD_CONSOLE_ACCESS_TOKEN: result.token.accessToken,
					CLOUD_CONSOLE_URI: consoleUri
				}
			}).show();
		})();
	};
}

async function findUserSettings(tokens: Token[]) {
	for (const token of tokens) {
		const userSettings = await getUserSettings(token.accessToken, token.session.environment.resourceManagerEndpointUrl);
		if (userSettings && userSettings.storageProfile) {
			return { userSettings, token };
		}
	}
}

async function requiresSetUp() {
	const open: MessageItem = { title: localize('azure-account.open', "Open") };
	const close: MessageItem = { title: localize('azure-account.close', "Close"), isCloseAffordance: true };
	const message = localize('azure-account.setUpInPortal', "First launch of Cloud Shell requires setup in the Azure portal (https://portal.azure.com).");
	const response = await window.showInformationMessage(message, open, close);
	if (response === open) {
		opn('https://portal.azure.com');
	}
}

async function deploymentConflict(retry: () => Promise<void>, os: OS, accessToken: string, armEndpoint: string) {
	const ok: MessageItem = { title: localize('azure-account.ok', "OK") };
	const cancel: MessageItem = { title: localize('azure-account.cancel', "Cancel"), isCloseAffordance: true };
	const message = localize('azure-account.deploymentConflict', "Starting a {0} session will terminate all active {1} sessions. Any running processes in active {1} sessions will be terminated.", os.shellName, os.otherOS.shellName);
	const response = await window.showWarningMessage(message, ok, cancel);
	if (response === ok) {
		await resetConsole(accessToken, armEndpoint);
		return retry();
	}
}

interface Token {
	session: AzureSession;
	accessToken: string;
	refreshToken: string;
}

async function acquireToken(session: AzureSession) {
	return new Promise<Token>((resolve, reject) => {
		const credentials: any = session.credentials;
		const environment: any = session.environment;
		credentials.context.acquireToken(environment.activeDirectoryResourceId, credentials.username, credentials.clientId, function (err: any, result: any) {
			if (err) {
				reject(err);
			} else {
				resolve({
					session,
					accessToken: result.accessToken,
					refreshToken: result.refreshToken
				});
			}
		});
	});
}

function delayed(fun: () => void, delay: number) {
	const handle = setTimeout(fun, delay);
	return {
		cancel: () => clearTimeout(handle)
	}
}