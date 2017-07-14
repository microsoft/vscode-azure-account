# Azure Login README

## Features

### Login

Calling the login method will result in an "authentication code" being automatically copied to the clipboard, and a browser being launched, which allows you to interactively authenticate with Azure. Once the login is complete, an Azure "service principal" is auto-created and persisted to disk, so that subsequent calls to login won't require re-authenticating. This allows your own apps to behave similarly to tools such as the Az CLI, without too much effort.

If you'd like to specify an exact Azure identity you can set the following environment variables (or [extension settings](Extension Settings)), which provide interop with other Azure management tools such as Serverless and Terraform:

* `azureSubId` / `ARM_SUBSRIPTION_ID`: The ID of the Azure subscription that you'd like to manage resources within
* `azureServicePrincipalClientId` / `ARM_CLIENT_ID`: The name of the service principal
* `azureServicePrincipalPassword` / `ARM_CLIENT_SECRET`: The password of the service principal
* `azureServicePrincipalTenantId` / `ARM_TENANT_ID`: The ID of the tenant that the service principal was created in

### Logout

### Show Subscriptions

### Use Subscription

## Requirements

## Extension Settings

This extension contributes the following settings:

* `azureLogin.azureSubId`: The ID of the Azure subscription that you'd like to manage resources within
* `azureLogin.azureServicePrincipalClientId`: The name of the service principal
* `azureLogin.azureServicePrincipalPassword`: The password of the service principal
* `azureLogin.azureServicePrincipalTenantId`: The ID of the tenant that the service principal 

## Known Issues

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## License
[MIT](LICENSE)