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

## Release Entry Points

Use these commands intentionally:

```bash
# Canonical release entrypoint:
# runs syntax checks, pushes Git, deploys live, then publishes to the Official MCP Registry
npm run deploy:remote

# Alias for the same full ship flow
npm run release:ship

# Deploy the live server only
npm run deploy:live

# Publish server.json to the Official MCP Registry only
npm run publish:registry
```

`deploy:remote` is now the maintainer-facing release entrypoint. It is the safest default because it does not stop at Git sync or PM2 rollout; it also completes the Official MCP Registry publish for the current `server.json`.

Operational assumptions:

- release shipping expects a clean git worktree by default
- release shipping is intentionally anchored to the current repository HEAD; use `npm run deploy:live` for artifact-only or non-git deployment cases
- Official MCP Registry publishing uses the local DNS key file at `/root/.config/mcp-registry/bitvoya.com/key.pem` unless overridden with `BITVOYA_MCP_REGISTRY_KEY_FILE`
- `server.json` versioning remains immutable at the registry level, so metadata changes still require a new unique `version`

## Remote HTTP Hardening

For public Streamable HTTP deployments, configure the public MCP origin and explicit host/origin allowlists so GET, POST, and browser preflight requests pass while DNS rebinding protection stays enabled.

Recommended production env values:

```bash
BITVOYA_MCP_PUBLIC_BASE_URL=https://bitvoya.com
BITVOYA_MCP_ALLOWED_HOSTS=bitvoya.com,www.bitvoya.com
BITVOYA_MCP_ALLOWED_ORIGINS=https://bitvoya.com,https://www.bitvoya.com
BITVOYA_MCP_ENABLE_DNS_REBINDING_PROTECTION=true
```
