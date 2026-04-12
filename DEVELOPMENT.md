# Development

This file is for Bitvoya maintainers and contributors.

## Local Run

```bash
cd /root/bitvoya_mcp
npm install
npm run start
```

## Local stdio MCP

Point your MCP client at:

- command: `node`
- args: `["/root/bitvoya_mcp/src/server.mjs"]`

## Useful Commands

```bash
npm run check:syntax
npm run smoke:discovery
npm run smoke:booking
npm run smoke:all
```
