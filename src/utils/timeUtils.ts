/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function timeout(ms: number, result: any = 'timeout') {
	return new Promise<never>((_, reject) => setTimeout(() => reject(result), ms));
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function delay<T = void>(ms: number, result?: T | PromiseLike<T>) {
	return new Promise(resolve => setTimeout(() => resolve(result), ms));
}
