/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
export { Response };

export default async function fetchUrl(url: RequestInfo, init?: RequestInit): Promise<Response> {
    console.log(`Fetching ${url}...`);

    const response = await fetch(url, init);

    console.log(`Returned ${response.status}.`);

    return response;
}
