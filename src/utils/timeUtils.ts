/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timeout(ms: number, result: any = 'timeout'): Promise<never> {
	return new Promise<never>((_, reject) => setTimeout(() => reject(result), ms));
}

export function delay<T = void>(ms: number, result?: T | PromiseLike<T>): Promise<T | PromiseLike<T> | undefined> {
	return new Promise(resolve => setTimeout(() => resolve(result), ms));
}
