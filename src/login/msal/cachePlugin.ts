/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICachePlugin, TokenCacheContext } from '@azure/msal-node';
import { credentialsSection } from '../../constants';
import { KeyTar, tryGetKeyTar } from '../../utils/keytar';
import { getSelectedEnvironment } from '../environments';

const keytar: KeyTar | undefined = tryGetKeyTar();

const beforeCacheAccess = async (cacheContext: TokenCacheContext): Promise<void> => {
	if (keytar) {
		const cachedValue: string | null = await keytar.getPassword(credentialsSection, (await getSelectedEnvironment()).name);
		cachedValue && cacheContext.tokenCache.deserialize(cachedValue);
	}
};

const afterCacheAccess = async (cacheContext: TokenCacheContext): Promise<void> => {
    if(keytar && cacheContext.cacheHasChanged) {
		await keytar.setPassword(credentialsSection, (await getSelectedEnvironment()).name, cacheContext.tokenCache.serialize());
    }
};

export const cachePlugin: ICachePlugin = {
	beforeCacheAccess,
	afterCacheAccess
};
