/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AuthLibrary } from "../constants";

export const authLibraryCacheKey: string = 'authLibraryCache';

export interface AuthLibraryCache {
    lastUsedAuthLibrary: AuthLibrary | undefined;
}
