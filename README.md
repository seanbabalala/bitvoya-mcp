# Bitvoya MCP

Read-only MCP server for Bitvoya's luxury travel grounding layer.

The first version is intentionally narrow:

- city grounding
- hotel grounding
- nearby POI context
- lightweight search for agent planning

It does not create bookings or handle payment / PII flows.

## Runtime Config

Runtime credentials are loaded from:

- `/root/.config/bitvoya-mcp/server.env`

See [CONFIGURATION.md](/root/bitvoya_mcp/CONFIGURATION.md) for the expected keys.

## Tools

- `search_cities`
- `get_city_grounding`
- `search_hotels`
- `get_hotel_grounding`

## Run

```bash
cd /root/bitvoya_mcp
npm install
npm run start
```

For local stdio integrations, point the MCP client at:

- command: `node`
- args: `["/root/bitvoya_mcp/src/server.mjs"]`

## Scope

This repository is the clean MCP-facing layer.

It should:

- read from `tripwiki_publish`
- expose stable, agent-friendly tools
- keep hotel / city grounding separate from growth automation

It should not:

- own Bitvoya web UX
- own backend booking contracts
- take payment or store sensitive guest data
