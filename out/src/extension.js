'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const azurelogin_1 = require("./azurelogin");
const telemetry_1 = require("./telemetry");
;
function activate(context) {
    context.subscriptions.push(new telemetry_1.Reporter(context));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.login', azurelogin_1.login));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.logout', azurelogin_1.logout));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.showSubscriptions', azurelogin_1.showSubscriptions));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-azurelogin.useSubscription', azurelogin_1.useSubscription));
}
exports.activate = activate;
function deactivate() {
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map