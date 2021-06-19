/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (_, argv) => {
	/**@type {import('webpack').Configuration}*/
	const config = {
		target: 'node',

		entry: {
			extension: './src/extension.ts',
			cloudConsoleLauncher: './src/cloudConsole/cloudConsoleLauncher.ts',
		},
		output: {
			path: path.join(__dirname, 'dist'),
			filename: '[name].js',
			libraryTarget: 'commonjs2',
			devtoolModuleFilenameTemplate: '../[resource-path]',
		},
		node: {
			__dirname: false, // leave the __dirname-behaviour intact
		},
		devtool: argv.mode === 'none' ? 'source-map' : undefined,
		externals: {
			vscode: 'commonjs vscode',
			bufferutil: 'commonjs bufferutil',
			'utf-8-validate': 'commonjs utf-8-validate',
			'./platform/openbsd': 'commonjs copy-paste-openbsd',
		},
		resolve: {
			extensions: ['.ts', '.js']
		},
		module: {
			// require
			unknownContextRegExp: /$^/,
			unknownContextCritical: false,
			// require(expr)
			exprContextRegExp: /$^/,
			exprContextCritical: false,
			// require("prefix" + expr + "surfix")
			wrappedContextRegExp: /$^/,
			wrappedContextCritical: false,
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [{
							loader: 'ts-loader',
							options: {
								compilerOptions: {
									sourceMap: true,
								}
							}
						}]
				},
				{
					test: /\.node$/,
					loader: "node-loader"
				}
			]
		},

		// Workaround for https://github.com/node-fetch/node-fetch/issues/784
		optimization: {
			minimizer: [
				new TerserPlugin({
					extractComments: false,
					terserOptions: {
						keep_classnames: /^AbortSignal$/,
					},
				}),
			],
		},
	}

	return config;
}