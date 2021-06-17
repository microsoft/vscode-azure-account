/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from '@azure/ms-rest-azure-env';
import { AuthenticationResult, AuthorizationCodeRequest, Configuration, LogLevel, PublicClientApplication } from '@azure/msal-node';
import { randomBytes } from 'crypto';
import { ServerResponse } from 'http';
import { CancellationTokenSource, MessageItem, Uri, window } from 'vscode';
import { clientId, commonTenantId, redirectUrlAAD, redirectUrlADFS, tenantSetting } from '../../constants';
import { AzureLoginError } from '../../errors';
import { localize } from '../../utils/localize';
import { openUri } from '../../utils/openUri';
import { getSettingValue } from '../../utils/settingUtils';
import { delay } from '../../utils/timeUtils';
import { redirectTimeout } from '../AzureLoginHelper';
import { getSelectedEnvironment, isADFS } from '../environments';
import { parseQuery } from '../login';
import { CodeResult, createServer, createTerminateServer, RedirectResult, startServer } from '../server';
import { waitUntilOnline } from '../waitUntilOnline';

// Authentication parameters
const config: Configuration = {
    auth: {
        clientId,
        authority: "https://login.microsoftonline.com/common"
    },
    system: {
        loggerOptions: {
            loggerCallback(_loglevel, message, _containsPii) {
                console.log(message);
            },
            piiLoggingEnabled: false,
            logLevel: LogLevel.Verbose,
        }
    }
};

let terminateServer: () => Promise<void>;

// Initialize MSAL Node object using authentication parameters
const publicClientApp: PublicClientApplication = new PublicClientApplication(config);





export async function login(): Promise<void> {
	// let environmentName: string = 'uninitialized';
	const cancelSource: CancellationTokenSource = new CancellationTokenSource();
	try {
		const environment: Environment = await getSelectedEnvironment();
		// environmentName = environment.name;
		const onlineTask: Promise<void> = waitUntilOnline(environment, 2000, cancelSource.token);
		const timerTask: Promise<boolean | PromiseLike<boolean> | undefined> = delay(2000, true);

		if (await Promise.race([onlineTask, timerTask])) {
			const cancel: MessageItem = { title: localize('azure-account.cancel', "Cancel") };
			await Promise.race([
				onlineTask,
				window.showInformationMessage(localize('azure-account.checkNetwork', "You appear to be offline. Please check your network connection."), cancel)
					.then(result => {
						if (result === cancel) {
							throw new AzureLoginError(localize('azure-account.offline', "Offline"));
						}
					})
			]);
			await onlineTask;
		}

		const tenantId: string = getSettingValue(tenantSetting) || commonTenantId;
		const isAdfs: boolean = isADFS(environment);
		// const tokenResponse: TokenResponse = await login(clientId, environment, isAdfs, tenantId, openUri, redirectTimeout);
		////////////////////////////////////////////////////////////////////
		// begin `login`
		////////////////////////////////////////////////////////////////////

		// if (vscode.env.uiKind === vscode.UIKind.Web) {
		// 	return loginWithoutLocalServer(clientId, environment, adfs, tenantId);
		// }
	
		if (isAdfs && terminateServer) {
			await terminateServer();
		}
	
		const nonce: string = randomBytes(16).toString('base64');
		const { server, redirectPromise, codePromise } = createServer(nonce);
	
		if (isAdfs) {
			terminateServer = createTerminateServer(server);
		}
	
		try {
			const port: number = await startServer(server, isAdfs);
			await openUri(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`);
			// eslint-disable-next-line @typescript-eslint/no-misused-promises
			const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);
	
			const redirectResult: RedirectResult = await redirectPromise;
			if ('err' in redirectResult) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const { err, res } = redirectResult;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				res.end();
				throw err;
			}
	
			clearTimeout(redirectTimer);
			const host: string = redirectResult.req.headers.host || '';
			const updatedPortStr: string = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
			const updatedPort: number = updatedPortStr ? parseInt(updatedPortStr, 10) : port;
	
			const state: string = `${updatedPort},${encodeURIComponent(nonce)}`;
			const redirectUrl: string = isAdfs ? redirectUrlADFS : redirectUrlAAD;
			const signInUrl: string = `${environment.activeDirectoryEndpointUrl}${isAdfs ? '' : `${tenantId}/`}oauth2/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&resource=${encodeURIComponent(environment.activeDirectoryResourceId)}&prompt=select_account`;
			redirectResult.res.writeHead(302, { Location: signInUrl })
			redirectResult.res.end();
	
			const codeResult: CodeResult = await codePromise;
			const serverResponse: ServerResponse = codeResult.res;
			try {
				if ('err' in codeResult) {
					throw codeResult.err;
				}
				const authResult: AuthenticationResult | null = await getTokenWithAuthorizationCode(clientId, environment, redirectUrl, tenantId, codeResult.code);
				serverResponse.writeHead(302, { Location: '/' });
				serverResponse.end();
				console.log(authResult);
			} catch (err) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				serverResponse.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				serverResponse.end();
				throw err;
			}
		} finally {
			setTimeout(() => {
				server.close();
			}, 5000);
		}


		////////////////////////////////////////////////////////////////////
		// end `login`
		////////////////////////////////////////////////////////////////////

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		// const refreshToken: string = tokenResponse.refreshToken!;
		// const tokenResponses: TokenResponse[] = tenantId === commonTenantId ? await tokensFromToken(environment, tokenResponse) : [tokenResponse];

		// await storeRefreshToken(environment, refreshToken);
		// await this.updateSessions(environment, tokenResponses);
		// void this.sendLoginTelemetry(trigger, path, environmentName, 'success', undefined, true);
	} catch (err) {
		if (err instanceof AzureLoginError && err.reason) {
			console.error(err.reason);
			// void this.sendLoginTelemetry(trigger, path, environmentName, 'error', getErrorMessage(err.reason) || getErrorMessage(err));
		} else {
			// void this.sendLoginTelemetry(trigger, path, environmentName, 'failure', getErrorMessage(err));
		}
		throw err;
	} finally {
		cancelSource.cancel();
		cancelSource.dispose();
		// this.updateLoginStatus();
	}
}

async function getTokenWithAuthorizationCode(_clientId: string, _environment: Environment, redirectUrl: string, _tenantId: string, code: string): Promise<AuthenticationResult | null> {
    // Use the auth code in redirect request to construct
    // a token request object
    const tokenRequest: AuthorizationCodeRequest = {
        code,
        scopes: ["user.read"],
        redirectUri: redirectUrl,
    };

    // Exchange the auth code for tokens
	let authResult: AuthenticationResult | null = null;
	try {
		authResult = await publicClientApp.acquireTokenByCode(tokenRequest);
	} catch (error) {
		console.log(error);
	}

	return authResult;
}




















export async function oldLogin(): Promise<AuthenticationResult | null> {
    // Construct a request object for auth code
    const authCodeUrlParameters = {
        scopes: ["user.read"],
        redirectUri: redirectUrlADFS,
    };

    // Request auth code, then redirect
    const authCodeUrl: string = await publicClientApp.getAuthCodeUrl(authCodeUrlParameters);

	const nonce: string = randomBytes(16).toString('base64');
	const { server, redirectPromise, codePromise } = createServer(nonce);

	if (terminateServer) {
		await terminateServer();
	}

	terminateServer = createTerminateServer(server);

	try {
		const port: number = await startServer(server, true);
		await openUri(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`);
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		const redirectTimer = setTimeout(() => redirectTimeout().catch(console.error), 10*1000);

		const redirectResult: RedirectResult = await redirectPromise;
		if ('err' in redirectResult) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const { err, res } = redirectResult;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			res.end();
			throw err;
		}

		clearTimeout(redirectTimer);
		// const host: string = redirectResult.req.headers.host || '';
		// const updatedPortStr: string = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
		// const updatedPort: number = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

		// const state: string = `${updatedPort},${encodeURIComponent(nonce)}`;
		// const redirectUrl: string = redirectUrlADFS;
		redirectResult.res.writeHead(302, { Location: authCodeUrl })
		redirectResult.res.end();

		const codeResult: CodeResult = await codePromise;
		const serverResponse: ServerResponse = codeResult.res;
		try {
			if ('err' in codeResult) {
				throw codeResult.err;
			}
			const authResult: AuthenticationResult | null = await oldGetTokenWithAuthCode(authCodeUrl);
			serverResponse.writeHead(302, { Location: '/' });
			serverResponse.end();
			return authResult;
		} catch (err) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			serverResponse.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
			serverResponse.end();
			throw err;
		}
	} finally {
		setTimeout(() => {
			server.close();
		}, 5000);
	}
}

export async function oldGetTokenWithAuthCode(authCodeUrl: string): Promise<AuthenticationResult | null> {
	await openUri(authCodeUrl);
	const authCodeUri: Uri = Uri.parse(authCodeUrl);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const parsedQuery = parseQuery(authCodeUri);

    // Use the auth code in redirect request to construct
    // a token request object
    const tokenRequest = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        code: parsedQuery.code,
        scopes: ["user.read"],
        redirectUri: redirectUrlADFS,
    };

    // Exchange the auth code for tokens
	let authResult: AuthenticationResult | null = null;
	try {
		authResult = await publicClientApp.acquireTokenByCode(tokenRequest);
	} catch (error) {
		console.log(error);
	}

	return authResult;
}