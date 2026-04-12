# Bitvoya MCP Operator Deployment

This file is the operational source of truth for the live MCP gateway.

It is for Bitvoya operators, not normal hosted MCP users.

## Rules

- Do not run the live MCP from the repo working tree by convention anymore.
- The live MCP should run from the release symlink:
  - `/root/releases/bitvoya_mcp/current`
- Always check status before and after deploy.

## Status

```bash
cd /root/bitvoya_mcp
npm run deploy:remote -- --status
```

Expected output includes:

- `current_release`
- `pm2_cwd_resolved`
- `health_status=up`
- `status=consistent`

## Release

```bash
cd /root/bitvoya_mcp
npm run deploy:remote
```

Or explicitly:

```bash
/root/bitvoya_mcp/scripts/release_live.sh --source /root/bitvoya_mcp --release-id <release-id>
```

What this does:

1. Creates a release under `/root/releases/bitvoya_mcp/releases`
2. Installs dependencies for that release
3. Runs `npm run check:syntax`
4. Updates `/root/releases/bitvoya_mcp/current`
5. Restarts PM2 app `bitvoya-mcp`
6. Verifies `http://127.0.0.1:3011/healthz`
7. Prints final live status

## Runtime Layout

- release root: `/root/releases/bitvoya_mcp`
- current link: `/root/releases/bitvoya_mcp/current`
- PM2 app: `bitvoya-mcp`
- health endpoint: `http://127.0.0.1:3011/healthz`
- MCP endpoint: `http://127.0.0.1:3011/mcp`

## Non-Negotiable Practice

- Use `npm run deploy:remote -- --status` before and after every MCP release.
- Do not assume PM2 `online` means the correct release is live.
- The release is only trusted when `current_release` and `pm2_cwd_resolved` match.
