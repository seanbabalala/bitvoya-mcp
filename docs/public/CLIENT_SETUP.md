# Bitvoya MCP Client Setup

This guide is for hosted Bitvoya MCP users.

Before you start, make sure you have:

- a Bitvoya account
- an agent key from Dashboard -> Connect Agent
- the hosted MCP endpoint: `https://bitvoya.com/api/mcp`

## Universal Connection Values

Use these values in any MCP client that supports remote Streamable HTTP plus custom headers:

```json
{
  "type": "streamable_http",
  "url": "https://bitvoya.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <your_agent_key>"
  }
}
```

Notes:

- replace `<your_agent_key>` with the real Bitvoya key created in your dashboard
- keep the `Bearer ` prefix
- if your client uses a different field name such as `baseUrl` or `requestHeaders`, keep the same endpoint and header values

## Cherry Studio

Cherry Studio supports MCP server configuration from the MCP settings area. UI labels may vary slightly by version, but the core values stay the same.

Recommended flow:

1. Open `Settings`
2. Open `MCP Server`
3. Add a new server
4. If your version asks for transport or type, choose the remote HTTP / Streamable HTTP option
5. Set the endpoint to:
   - `https://bitvoya.com/api/mcp`
6. Add a request header:
   - `Authorization: Bearer <your_agent_key>`
7. Save and enable the server
8. In chat, test a tool-driven prompt such as:
   - `Search luxury hotels in Tokyo for next weekend and compare the best options.`

If your Cherry Studio version supports JSON import, this shape is typically the easiest starting point:

```json
{
  "name": "Bitvoya MCP",
  "type": "streamable_http",
  "url": "https://bitvoya.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <your_agent_key>"
  }
}
```

## Generic MCP Clients

If your client supports remote MCP servers, you usually only need:

- endpoint URL
- bearer header
- tool use enabled in the conversation

If your client supports session or timeout tuning, the default Bitvoya setup works well without custom values.

## First Test Prompts

After connecting, test with prompts that clearly require hotel search and comparison.

Examples:

- `Find luxury hotels in Paris for a 3-night stay next month and compare the top options.`
- `Search Tokyo hotels with strong member benefits and explain the best rate choices.`
- `Prepare a booking quote for this hotel and show the price breakdown before checkout.`

## Common Issues

### Unauthorized or auth failed

Check:

- the key was copied fully
- the header includes `Bearer `
- the key has not been revoked
- you are using the hosted endpoint, not a local path

### Server connects but tools do not run

Check:

- MCP tool use is enabled in your client
- the server is enabled in the current chat
- your client supports remote MCP, not only local stdio MCP

### The client asks for command and args instead of URL

That usually means the client is trying to configure a local stdio MCP server.

For Bitvoya hosted access, use the remote MCP mode and enter:

- URL: `https://bitvoya.com/api/mcp`
- Header: `Authorization: Bearer <your_agent_key>`

## Security Reminder

- do not share your agent key publicly
- revoke and rotate a key from the Bitvoya dashboard if you think it was exposed
- your website password and your agent key are different credentials
