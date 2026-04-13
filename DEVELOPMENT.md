# Development

This file is for Bitvoya maintainers and contributors.

## Local Run

```bash
cd <repo_root>
npm install
npm run start
```

## Local stdio MCP

Point your MCP client at:

- command: `node`
- args: `["<repo_root>/src/server.mjs"]`

## Useful Commands

```bash
npm run check:syntax
npm run smoke:transport
npm run smoke:discovery
npm run smoke:booking
npm run smoke:all
```

## Remote HTTP Hardening

For public Streamable HTTP deployments, configure the public MCP origin and explicit host/origin allowlists so GET, POST, and browser preflight requests pass while DNS rebinding protection stays enabled.

Recommended production env values:

```bash
BITVOYA_MCP_PUBLIC_BASE_URL=https://bitvoya.com
BITVOYA_MCP_ALLOWED_HOSTS=bitvoya.com,www.bitvoya.com
BITVOYA_MCP_ALLOWED_ORIGINS=https://bitvoya.com,https://www.bitvoya.com
BITVOYA_MCP_ENABLE_DNS_REBINDING_PROTECTION=true
```
