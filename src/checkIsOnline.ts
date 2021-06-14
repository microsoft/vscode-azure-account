/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Environment } from "@azure/ms-rest-azure-env";
import * as http from 'http';
import * as https from 'https';
import { CancellationTokenSource } from "vscode";
import { delay } from "./utils/timeUtils";


// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function becomeOnline(environment: Environment, interval: number, token = new CancellationTokenSource().token) {
	let o = isOnline(environment);
	let d = delay(interval, false);
	while (!token.isCancellationRequested && !await Promise.race([o, d])) {
		await d;
		o = asyncOr(o, isOnline(environment));
		d = delay(interval, false);
	}
}

async function isOnline(environment: Environment) {
	try {
		await new Promise<http.IncomingMessage>((resolve, reject) => {
			const url = environment.activeDirectoryEndpointUrl;
			(url.startsWith('https:') ? https : http).get(url, resolve)
				.on('error', reject);
		});
		return true;
	} catch (err) {
		console.warn(err);
		return false;
	}
}

async function asyncOr<A, B>(a: Promise<A>, b: Promise<B>) {
	return Promise.race([awaitAOrB(a, b), awaitAOrB(b, a)]);
}

async function awaitAOrB<A, B>(a: Promise<A>, b: Promise<B>) {
	return (await a) || b;
}
