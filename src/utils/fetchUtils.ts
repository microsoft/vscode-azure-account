/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fetch, { RequestInfo, RequestInit, Response } from 'node-fetch';
import { ext } from '../extensionVariables';
export { Response };

export default async function fetchUrl(url: RequestInfo, init?: RequestInit): Promise<Response> {
    ext.outputChannel.append(`Fetching ${url}...`);

    try {
        const response = await fetch(url, init);
        
        ext.outputChannel.append(`Fetching ${url} response: ${response.status}`);
        
        return response;
    } catch (error) {
        ext.outputChannel.append(`Fetching ${url} failed: ${error}`);

        throw error;
    }
}
