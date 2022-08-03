import { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";

export class LoggedNetworkModule implements INetworkModule {
    constructor(private readonly innerModule: INetworkModule) {
    }

    sendGetRequestAsync<T>(url: string, options?: NetworkRequestOptions | undefined, cancellationToken?: number | undefined): Promise<NetworkResponse<T>> {
        return this.innerModule.sendGetRequestAsync(url, options, cancellationToken);
    }

    sendPostRequestAsync<T>(url: string, options?: NetworkRequestOptions | undefined): Promise<NetworkResponse<T>> {
        return this.innerModule.sendPostRequestAsync(url, options);
    }
}
