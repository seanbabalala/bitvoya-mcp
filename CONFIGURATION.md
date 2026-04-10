# Configuration

This server reads runtime-only credentials from:

- `/root/.config/bitvoya-mcp/server.env`

These values must not be committed.

## Expected Keys

```bash
BITVOYA_MCP_SERVER_NAME=bitvoya-mcp
BITVOYA_MCP_SERVER_VERSION=0.1.0
BITVOYA_MCP_DB_HOST=127.0.0.1
BITVOYA_MCP_DB_PORT=3306
BITVOYA_MCP_DB_NAME=tripwiki_publish
BITVOYA_MCP_DB_USER=tripwiki_publish
BITVOYA_MCP_DB_PASSWORD=replace-me
BITVOYA_MCP_DEFAULT_SEARCH_LIMIT=5
BITVOYA_MCP_MAX_SEARCH_LIMIT=12
BITVOYA_MCP_DEFAULT_POI_LIMIT=8
```

## Notes

- this server is read-only
- the primary schema is `tripwiki_publish`
- if Bitvoya later adds live booking tools, keep credentials and safety policy separate from this first grounding layer
