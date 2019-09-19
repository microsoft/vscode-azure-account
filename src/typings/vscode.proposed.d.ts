/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This is the place for API experiments and proposals.
 * These API are NOT stable and subject to change. They are only available in the Insiders
 * distribution and CANNOT be used in published extensions.
 *
 * To test these API in local environment:
 * - Use Insiders release of VS Code.
 * - Add `"enableProposedApi": true` to your package.json.
 * - Copy this file to your project.
 */

declare module 'vscode' {

	// #region resolveExternalUri — mjbvz

	namespace env {
		/**
		 * Resolves an *external* uri, such as a `http:` or `https:` link, from where the extension is running to a
		 * uri to the same resource on the client machine.
		 *
		 * This is a no-oop if the extension is running locally. Currently only supports `https:` and `http:`.
		 *
		 * If the extension is running remotely, this function automatically establishes port forwarding from
		 * the local machine to `target` on the remote and returns a local uri that can be used to for this connection.
		 *
		 * Note that uris passed through `openExternal` are automatically resolved.
		 *
		 * @return A uri that can be used on the client machine. Extensions should dispose of the returned value when
		 * both the extension and the user are no longer using the value. For port forwarded uris, `dispose` will
		 * close the connection.
		 */
		export function resolveExternalUri(target: Uri): Thenable<{ resolved: Uri, dispose(): void }>;
	}

	//#endregion
}