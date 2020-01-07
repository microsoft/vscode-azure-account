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

	// #region Ben - extension auth flow (desktop+web)

	export interface AppUriOptions {
		payload?: {
			path?: string;
			query?: string;
			fragment?: string;
		};
	}

	export namespace env {

		/**
		 * Creates a Uri that - if opened in a browser - will result in a
		 * registered [UriHandler](#UriHandler) to fire. The handler's
		 * Uri will be configured with the path, query and fragment of
		 * [AppUriOptions](#AppUriOptions) if provided, otherwise it will be empty.
		 *
		 * Extensions should not make any assumptions about the resulting
		 * Uri and should not alter it in anyway. Rather, extensions can e.g.
		 * use this Uri in an authentication flow, by adding the Uri as
		 * callback query argument to the server to authenticate to.
		 *
		 * Note: If the server decides to add additional query parameters to the Uri
		 * (e.g. a token or secret), it will appear in the Uri that is passed
		 * to the [UriHandler](#UriHandler).
		 *
		 * **Example** of an authentication flow:
		 * ```typescript
		 * vscode.window.registerUriHandler({
		 *   handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
		 *     if (uri.path === '/did-authenticate') {
		 *       console.log(uri.toString());
		 *     }
		 *   }
		 * });
		 *
		 * const callableUri = await vscode.env.createAppUri({ payload: { path: '/did-authenticate' } });
		 * await vscode.env.openExternal(callableUri);
		 * ```
		 */
		export function createAppUri(options?: AppUriOptions): Thenable<Uri>;

		export function asExternalUri(target: Uri): Thenable<Uri>;
	}

	// #region Ben - UIKind

	/**
	 * Possible kinds of UI that can use extensions.
	 */
	export enum UIKind {

		/**
		 * Extensions are accessed from a desktop application.
		 */
		Desktop = 1,

		/**
		 * Extensions are accessed from a web browser.
		 */
		Web = 2
	}

	export namespace env {

		/**
		 * The UI kind property indicates from which UI extensions
		 * are accessed from. For example, extensions could be accessed
		 * from a desktop application or a web browser.
		 */
		export const uiKind: UIKind;
	}
}