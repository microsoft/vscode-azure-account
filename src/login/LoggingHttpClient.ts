import { HttpClient, HttpOperationResponse, WebResourceLike } from "@azure/ms-rest-js";
import { ext } from "../extensionVariables";

export class LoggingHttpClient implements HttpClient {
    constructor(private readonly innerClient: HttpClient) {
    }

    async sendRequest(httpRequest: WebResourceLike): Promise<HttpOperationResponse> {
        ext.outputChannel.appendLine(`Azure SDK: ${httpRequest.method} ${httpRequest.url}...`);

        try {
            const response = await this.innerClient.sendRequest(httpRequest);

            ext.outputChannel.appendLine(`Azure SDK: ${httpRequest.method} ${httpRequest.url} response: ${response.status}`);

            return response;
        } catch (error) {
            ext.outputChannel.appendLine(`Azure SDK: ${httpRequest.method} ${httpRequest.url} failed: ${error}`);

            throw error;
        }
    }
}
