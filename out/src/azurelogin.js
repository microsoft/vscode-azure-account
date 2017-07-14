"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const telemetry_1 = require("./telemetry");
const vscode = require("vscode");
const { azLogin, azLogout } = require("az-login");
const teleCmdId = '';
function login() {
    return __awaiter(this, void 0, void 0, function* () {
        let teleCmdId = 'vscode-azurelogin.login';
        const signInMessage = 'The code {0} has been copied to your clipboard. Click Login and paste in the code to authenticate.';
        const { credentials } = yield azLogin({ interactiveLoginHandler: (code, message) => {
                vscode.window.showInformationMessage(message);
            } });
        if (telemetry_1.reporter) {
            telemetry_1.reporter.sendTelemetryEvent('command', {
                command: teleCmdId
            });
        }
    });
}
exports.login = login;
function logout() {
    return __awaiter(this, void 0, void 0, function* () {
        let teleCmdId = 'vscode-azurelogin.logout';
        yield azLogout();
        if (telemetry_1.reporter) {
            telemetry_1.reporter.sendTelemetryEvent('command', {
                command: teleCmdId
            });
        }
    });
}
exports.logout = logout;
function showSubscriptions() {
    return __awaiter(this, void 0, void 0, function* () {
        let teleCmdId = 'vscode-azurelogin.showSubscriptions';
        if (telemetry_1.reporter) {
            telemetry_1.reporter.sendTelemetryEvent('command', {
                command: teleCmdId
            });
        }
    });
}
exports.showSubscriptions = showSubscriptions;
function useSubscription(sub) {
    return __awaiter(this, void 0, void 0, function* () {
        let teleCmdId = 'vscode-azurelogin.useSubscription';
        if (telemetry_1.reporter) {
            telemetry_1.reporter.sendTelemetryEvent('command', {
                command: teleCmdId
            });
        }
    });
}
exports.useSubscription = useSubscription;
//# sourceMappingURL=azurelogin.js.map