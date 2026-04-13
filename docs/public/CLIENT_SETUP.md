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
- low-level manual HTTP testing should also send `Accept: application/json, text/event-stream`

## Registry Metadata

This repository ships a root-level `server.json` for registry-oriented and machine-readable MCP installation flows:

- [server.json](../../server.json)

That metadata points to the same hosted endpoint:

- `https://bitvoya.com/api/mcp`

and still requires the same Bitvoya-issued bearer credential:

- `Authorization: Bearer <your_agent_key>`

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

Important compatibility note:

- Cherry Studio may reject the generic flat JSON examples that work in other MCP clients
- for Cherry Studio, prefer `type: streamableHttp` plus `baseUrl`
- some Cherry Studio versions also behave more reliably if `Authorization` is added manually after import rather than embedded inside the imported JSON

Recommended Cherry Studio JSON import shape:

```json
{
  "mcpServers": {
    "bitvoya": {
      "name": "Bitvoya MCP",
      "type": "streamableHttp",
      "description": "Bitvoya luxury hotel MCP",
      "isActive": true,
      "baseUrl": "https://bitvoya.com/api/mcp"
    }
  }
}
```

After import, open the Bitvoya MCP entry and manually add:

- `Authorization: Bearer <your_agent_key>`

Do not assume this older generic shape will import correctly in Cherry Studio:

```json
{
  "type": "streamable_http",
  "url": "https://bitvoya.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <your_agent_key>"
  }
}
```

That format may still work in some other MCP clients, but Cherry Studio users should prefer the wrapped `mcpServers` import above or manual form entry.

## Cursor

Cursor supports remote MCP servers through `mcp.json`.

Recommended setup:

1. Open or create one of these files:
   - project-specific: `.cursor/mcp.json`
   - global: `~/.cursor/mcp.json`
2. Add a Bitvoya entry:

```json
{
  "mcpServers": {
    "bitvoya": {
      "url": "https://bitvoya.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BITVOYA_AGENT_KEY}"
      }
    }
  }
}
```

3. Export your key before launching Cursor:

```bash
export BITVOYA_AGENT_KEY="<your_agent_key>"
```

4. Enable the server in Cursor and test a hotel-search prompt.

Notes:

- Cursor also supports one-click MCP installation and registry-oriented flows, but the JSON above is the most explicit manual setup
- using an environment variable is safer than hardcoding the bearer token into `mcp.json`

## Windsurf

Windsurf supports remote MCP over Streamable HTTP.

Recommended flow:

1. Open Windsurf MCP settings from the Cascade panel, or edit the raw `mcp_config.json`
2. Add a remote HTTP entry like this:

```json
{
  "mcpServers": {
    "bitvoya": {
      "serverUrl": "https://bitvoya.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BITVOYA_AGENT_KEY}"
      }
    }
  }
}
```

3. Set the environment variable used above:

```bash
export BITVOYA_AGENT_KEY="<your_agent_key>"
```

4. Enable the MCP inside Cascade and test a tool-using prompt.

Notes:

- Windsurf documents `serverUrl` for remote HTTP MCP entries; some versions also accept `url`
- Windsurf supports manual tool toggling, which is useful if you want Bitvoya exposed only in travel-oriented chats

## Claude Code

Claude Code supports remote HTTP MCP servers directly from the CLI.

Recommended command:

```bash
claude mcp add --transport http bitvoya https://bitvoya.com/api/mcp \
  --header "Authorization: Bearer $BITVOYA_AGENT_KEY"
```

If you want the config available across projects, add `--scope user`:

```bash
claude mcp add --scope user --transport http bitvoya https://bitvoya.com/api/mcp \
  --header "Authorization: Bearer $BITVOYA_AGENT_KEY"
```

Before running the command:

```bash
export BITVOYA_AGENT_KEY="<your_agent_key>"
```

Useful follow-up commands:

- `claude mcp list`
- `claude mcp get bitvoya`
- `/mcp`

## GitHub Copilot CLI

GitHub Copilot CLI supports remote HTTP MCP servers.

Interactive setup:

1. Start Copilot CLI interactive mode
2. Run:
   - `/mcp add`
3. Choose server type:
   - `HTTP`
4. Fill in:
   - server name: `bitvoya`
   - URL: `https://bitvoya.com/api/mcp`
   - HTTP headers: `{"Authorization":"Bearer <your_agent_key>"}`
   - tools: `*`
5. Save

Manual config file option:

```json
{
  "mcpServers": {
    "bitvoya": {
      "type": "http",
      "url": "https://bitvoya.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <your_agent_key>"
      },
      "tools": ["*"]
    }
  }
}
```

Store that in:

- `~/.copilot/mcp-config.json`

## Goose

Goose supports remote extensions over Streamable HTTP.

CLI flow:

1. Run:
   - `goose configure`
2. Choose:
   - `Add Extension`
   - `Remote Extension (Streamable HTTP)`
3. Name the extension:
   - `bitvoya`
4. Set the endpoint:
   - `https://bitvoya.com/api/mcp`
5. Add a custom header:
   - `Authorization: Bearer <your_agent_key>`
6. Save and enable the extension

Desktop flow:

1. Open the Extensions area
2. Add a custom extension
3. Choose remote / Streamable HTTP
4. Enter the same Bitvoya endpoint and `Authorization` header

## Other Remote-Capable Hosts

If a client supports remote MCP over Streamable HTTP, the portable values are still the same:

- URL: `https://bitvoya.com/api/mcp`
- header: `Authorization: Bearer <your_agent_key>`
- preferred model: `Claude 4.6`, `GPT-5.4`, or a comparable flagship model with strong tool-use behavior

## Generic MCP Clients

If your client supports remote MCP servers, you usually only need:

- endpoint URL
- bearer header
- tool use enabled in the conversation

If your client supports session or timeout tuning, the default Bitvoya setup works well without custom values.

## Recommended Model Selection

If your client also lets you choose which LLM drives the MCP session, prefer a higher-capability model with strong tool-use behavior.

Recommended direction:

- use models such as `Claude 4.6` and `GPT-5.4`, or comparable flagship models
- these models usually follow Bitvoya tool calls and multi-step booking workflows more accurately
- smaller models may still work, but they are more likely to answer from general knowledge instead of calling tools, or to lose the correct quote -> intent -> handoff -> state sequence

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

### Initialize returns 406 Not Acceptable

That usually means the request is missing the MCP accept header pair.

For raw HTTP testing, include:

- `Accept: application/json, text/event-stream`

Most MCP desktop clients handle this automatically.

### Server connects but tools do not run

Check:

- MCP tool use is enabled in your client
- the server is enabled in the current chat
- your client supports remote MCP, not only local stdio MCP

### Cherry Studio says the imported JSON is invalid

Check:

- you are using the wrapped `mcpServers` import shape shown in the Cherry Studio section
- the server entry uses `type: streamableHttp`
- the endpoint field is `baseUrl`, not `url`
- you add `Authorization` manually after import if your Cherry Studio version ignores or rejects imported headers

### The client asks for command and args instead of URL

That usually means the client is trying to configure a local stdio MCP server.

For Bitvoya hosted access, use the remote MCP mode and enter:

- URL: `https://bitvoya.com/api/mcp`
- Header: `Authorization: Bearer <your_agent_key>`

## Security Reminder

- do not share your agent key publicly
- revoke and rotate a key from the Bitvoya dashboard if you think it was exposed
- your website password and your agent key are different credentials

## Raw HTTP Debug Example

This is only for debugging. Normal users should connect through an MCP client UI.

```bash
curl https://bitvoya.com/api/mcp \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <your_agent_key>' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {
        "name": "debug-client",
        "version": "1.0"
      }
    }
  }'
```
