# Azure Account Extension Design and Architecture

This document provides notes on the design and architecture of the Azure Account extension that may be helpful to maintainers.

> NOTE: This document contains Mermaid-based diagrams. Use the [VS Code Mermaid extension](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid) for viewing and editing locally.

## Desktop Authentication Flow

For each authentication event, the extension starts a local HTTP server on a random port (`{port}`) and shares with it a random nonce (`{nonce}`) to ensure only its redirects will be accepted. The extension then asks VS Code to open a browser window and navigate to the local `/signin` endpoint. The extension then redirects the request to the OAuth provider, providing its `/callback` endpoint as the redirection URL. After authentication, the OAuth provider will redirect to the redirection URL and include the server code as a query parameter. Before returning a response, the extension will exchange the server code for access/refresh tokens, using the SDK for the selected OAuth provider. When complete, the extension will redirect the browser its `/` endpoint, which returns a final "you can close this page" HTML page. With that done, the server will be scheduled for shutdown (within 5s).

```mermaid
sequenceDiagram
    participant VSCode
    participant Extension
    participant Browser
    participant OAuth Provider

    Extension->>Extension: "Start server on localhost:{port} with nonce={nonce}"
    Extension->>VSCode: "Open browser to http://localhost:{port}/signin?nonce={nonce}"
    VSCode->>Browser: "Browse to http://localhost:{port}/signin?nonce={nonce}"
    Browser->>Extension: "GET http://localhost:{port}/signin?nonce={nonce}"
    Extension-->>Browser: "302: https://{endpoint}/oauth2/authorize?redirect_uri=127.0.0.1:{port}/callback?nonce={nonce}"
    Browser->>OAuth Provider: "GET https://{endpoint}/oauth2/authorize?redirect_uri=127.0.0.1:{port}/callback?nonce={nonce}"
    OAuth Provider-->>Browser: "302 http://127.0.0.1:{port}/callback?nonce={nonce}&code={code}"
    Browser->>Extension: "GET https://127.0.0.1:{port}/callback?nonce={nonce}&code={code}"
    Note over Extension, Browser: Authentication is complete so redirect to "can close page" page.
    Extension-->>Browser: "302 /"
    Browser->>Extension: "GET /"
    Extension-->>Browser: "200 {index.html}"
    Browser->>Extension: "GET main.css"
    Extension-->>Browser: "200 {main.css}"
    Extension->>Extension: "Stop server on localhost:{port}"
```