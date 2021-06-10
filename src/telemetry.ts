/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from 'vscode';
import TReporter from 'vscode-extension-telemetry';
import { aiKey, name, version } from '../package.json';

export interface TelemetryReporter {
    sendSanitizedEvent(eventName: string, properties?: { [key: string]: string; }): void;
}

const MESSAGE = 'message';
const PROPS = [MESSAGE];

export function createReporter(context: ExtensionContext): TelemetryReporter {
    const reporter = new class implements TelemetryReporter {
        private _reporter: TReporter;

        constructor() {
            this._reporter = new TReporter(name, version, aiKey, true);
        }

        sendSanitizedEvent(eventName: string, properties?: { [key: string]: string; } | undefined): void {
            if (properties && properties[MESSAGE]) {
                this._reporter.sendTelemetryErrorEvent(eventName, properties, undefined, PROPS);
            } else {
                this._reporter.sendTelemetryEvent(eventName, properties);
            }
        }

        dispose() {
            void this._reporter.dispose();
        }

    }
    context.subscriptions.push(reporter);
    return reporter;
}
