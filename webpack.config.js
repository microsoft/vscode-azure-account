/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

// See https://github.com/Microsoft/vscode-azuretools/wiki/webpack for guidance

'use strict';

const process = require('process');
const dev = require("vscode-azureextensiondev");
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const path = require('path');
const webpack = require('webpack');

let DEBUG_WEBPACK = true;//!!process.env.DEBUG_WEBPACK;

function toGlobSafePath(fsPath) {
    return fsPath.replace(/\\/g, '/');
}

let _config = dev.getDefaultWebpackConfig({
	entries: {
		cloudConsoleLauncher: './src/cloudConsole/cloudConsoleLauncher.ts',
	},
    projectRoot: __dirname,
    verbosity: DEBUG_WEBPACK ? 'debug' : 'normal',
    externals: {
		bufferutil: 'commonjs bufferutil',
		'utf-8-validate': 'commonjs utf-8-validate',
		'./platform/openbsd': 'commonjs copy-paste-openbsd',
	},
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                { from: './out/src/utils/getCoreNodeModule.js', to: 'node_modules' }
            ]
        })
    ]
});


const config = {
	"context": __dirname,
	"target": "node",
	"node": {
		"__filename": false,
		"__dirname": false
	},
	"entry": {
		"extension.bundle": "./extension.bundle.ts",
		"cloudConsoleLauncher": "./src/cloudConsole/cloudConsoleLauncher.ts"
	},
	"output": {
		"path": "/Users/will/Repos/vscode-azure-account1/dist",
		"filename": "[name].js",
		"libraryTarget": "commonjs2",
		"devtoolModuleFilenameTemplate": "../[resource-path]"
	},
	"devtool": "source-map",
	"externals": {
		"vscode": "commonjs vscode",
		"bufferutil": "commonjs bufferutil",
		"utf-8-validate": "commonjs utf-8-validate",
		"./platform/openbsd": "commonjs copy-paste-openbsd",
		"define-lazy-prop": "commonjs define-lazy-prop",
		"is-docker": "commonjs is-docker",
		"is-wsl": "commonjs is-wsl",
		"open": "commonjs open"
	},
	"optimization": {
        minimizer: [
            new TerserPlugin({
                terserOptions: {
                    // https://github.com/webpack-contrib/terser-webpack-plugin/

                    // Don't mangle class names.  Otherwise parseError() will not recognize user cancelled errors (because their constructor name
                    // will match the mangled name, not UserCancelledError).  Also makes debugging easier in minified code.
                    keep_classnames: true,

                    // Don't mangle function names. https://github.com/microsoft/vscode-azurestorage/issues/525
                    keep_fnames: true
                }
            })
        ]
	},
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                { from: './out/src/utils/getCoreNodeModule.js', to: 'node_modules' }
            ]
        })
	],
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [{
                    // Note: the TS loader will transpile the .ts file directly during webpack (i.e., webpack is directly pulling the .ts files, not .js files from out/)
                    loader: require.resolve('ts-loader')
                }]
            },

            // Note: If you use`vscode-nls` to localize your extension than you likely also use`vscode-nls-dev` to create language bundles at build time.
            // To support webpack, a loader has been added to vscode-nls-dev .Add the section below to the`modules/rules` configuration.
            // {
            //     // vscode-nls-dev loader:
            //     // * rewrite nls-calls
            //     loader: require.resolve('vscode-nls-dev/lib/webpack-loader'),
            //     options: {
            //         base: path.join(options.projectRoot, 'src')
            //     }
            // }

        ]
    },
	"resolve": {
		"extensions": [
			".ts",
			".js"
		]
	}
}

if (DEBUG_WEBPACK) {
    // console.log('Config:', JSON.stringify(config));
    console.log('Config:', config);
}

module.exports = config;
