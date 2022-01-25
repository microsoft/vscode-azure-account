/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from 'vscode';
import TReporter from 'vscode-extension-telemetry';

export interface TelemetryReporter {
    sendSanitizedEvent(eventName: string, properties?: { [key: string]: string; }): void;
}

const MESSAGE = 'message';
const PROPS = [MESSAGE];

export function createReporter(context: ExtensionContext): TelemetryReporter {
    const reporter = new class implements TelemetryReporter {
        private _reporter: TReporter;

        constructor() {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
            const extensionPackage = require('../package.json');
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            this._reporter = new TReporter(extensionPackage.name, extensionPackage.version, extensionPackage.aiKey, true);
        }

        sendSanitizedEvent(eventName: string, properties?: { [key: string]: string; } | undefined): void {
            if (properties && properties[MESSAGE]) {
                this._reporter.sendTelemetryErrorEvent(eventName, properties, undefined, PROPS);
            } else {
                this._reporter.sendTelemetryEvent(eventName, properties);
            }
        }

        dispose() {
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            this._reporter.dispose();
        }

    }
    context.subscriptions.push(reporter);
    return reporter;
}
