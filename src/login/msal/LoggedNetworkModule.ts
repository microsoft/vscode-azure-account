import { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";
import { ext } from "../../extensionVariables";

export class LoggedNetworkModule implements INetworkModule {
    constructor(private readonly innerModule: INetworkModule) {
    }

    async sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions | undefined, cancellationToken?: number | undefined): Promise<NetworkResponse<T>> {
        ext.outputChannel.appendLine(`MSAL: GET ${url}...`);

        try {
            const response = await this.innerModule.sendGetRequestAsync<T>(url, options, cancellationToken);

            ext.outputChannel.appendLine(`MSAL: GET ${url} response: ${response.status}`);

            return response;
        } catch (error) {
            ext.outputChannel.appendLine(`MSAL: GET ${url} failed: ${error}`);

            throw error;
        }
    }

    async sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions | undefined): Promise<NetworkResponse<T>> {
        ext.outputChannel.appendLine(`MSAL: POST ${url}...`);

        try {
            const response = await this.innerModule.sendPostRequestAsync<T>(url, options);

            ext.outputChannel.appendLine(`MSAL: POST ${url} response: ${response.status}`);

            return response;
        } catch (error) {
            ext.outputChannel.appendLine(`MSAL: POST ${url} failed: ${error}`);

            throw error;
        }
    }
}
