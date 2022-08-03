import { Configuration, PublicClientApplication } from "@azure/msal-node";
import { LoggedNetworkModule } from "./LoggedNetworkModule";

export class AzureAccountClientApplication extends PublicClientApplication {
    constructor(configuration: Configuration) {
        super(configuration);

        this.config.system.networkClient = new LoggedNetworkModule(this.config.system.networkClient);
    }
}
