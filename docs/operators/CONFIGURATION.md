# Bitvoya MCP Operator Configuration

This document is for Bitvoya operators and maintainers.

Normal hosted MCP users do not need any of these values. They only need:

- MCP endpoint: `https://bitvoya.com/api/mcp`
- Bitvoya agent key from Dashboard -> Connect Agent

This server reads runtime-only credentials from:

- `/root/.config/bitvoya-mcp/server.env`

These values must not be committed.

## Expected Keys

```bash
BITVOYA_MCP_SERVER_NAME=bitvoya-mcp
BITVOYA_MCP_SERVER_VERSION=0.2.0
BITVOYA_MCP_TRANSPORT=stdio
BITVOYA_MCP_HTTP_HOST=127.0.0.1
BITVOYA_MCP_HTTP_PORT=3011
BITVOYA_MCP_HTTP_PATH=/mcp
BITVOYA_MCP_HTTP_HEALTH_PATH=/healthz
BITVOYA_MCP_DB_HOST=127.0.0.1
BITVOYA_MCP_DB_PORT=3306
BITVOYA_MCP_DB_NAME=tripwiki_publish
BITVOYA_MCP_DB_USER=tripwiki_publish
BITVOYA_MCP_DB_PASSWORD=replace-me
BITVOYA_MCP_AUTH_DB_HOST=127.0.0.1
BITVOYA_MCP_AUTH_DB_PORT=3306
BITVOYA_MCP_AUTH_DB_NAME=app_bitvoya
BITVOYA_MCP_AUTH_DB_USER=app_bitvoya
BITVOYA_MCP_AUTH_DB_PASSWORD=replace-me
BITVOYA_API_BASE_URL=https://app.bitvoya.com/api
BITVOYA_API_TIMEOUT_MS=30000
BITVOYA_API_BEARER_TOKEN=
BITVOYA_API_ACCEPT_LANGUAGE=en
BITVOYA_API_USER_AGENT=bitvoya-mcp/0.2.0
BITVOYA_MCP_BOOKING_EXECUTION_MODE=executor_handoff
BITVOYA_MCP_HANDOFF_MODE=planned
BITVOYA_MCP_HANDOFF_BASE_URL=
BITVOYA_MCP_HANDOFF_SIGNING_SECRET=
BITVOYA_MCP_HANDOFF_TOKEN_TTL_SECONDS=1800
BITVOYA_MCP_STORE_PATH=/root/.config/bitvoya-mcp/runtime-store.json
BITVOYA_MCP_QUOTE_TTL_SECONDS=900
BITVOYA_MCP_INTENT_RETENTION_SECONDS=604800
BITVOYA_MCP_CARD_ENCRYPTION_KEY=replace-me
BITVOYA_MCP_DEFAULT_SEARCH_LIMIT=5
BITVOYA_MCP_MAX_SEARCH_LIMIT=12
BITVOYA_MCP_DEFAULT_POI_LIMIT=8
BITVOYA_MCP_DEFAULT_ROOM_LIMIT=5
BITVOYA_MCP_MAX_ROOM_LIMIT=10
BITVOYA_MCP_DEFAULT_RATE_LIMIT=4
BITVOYA_MCP_MAX_RATE_LIMIT=10
BITVOYA_MCP_REMOTE_AUTH_MODE=bearer
BITVOYA_MCP_REMOTE_TOKEN_HEADER=authorization
BITVOYA_MCP_REMOTE_PRINCIPAL_HEADER=x-bitvoya-principal
BITVOYA_MCP_REMOTE_SIGNATURE_HEADER=x-bitvoya-signature
BITVOYA_MCP_REMOTE_AUTH_SHARED_SECRET=replace-me
BITVOYA_MCP_TOKEN_PEPPER=
BITVOYA_MCP_REMOTE_AUTH_MAX_SKEW_SECONDS=300
BITVOYA_MCP_REMOTE_REQUIRED_SCOPES=inventory.read,grounding.read
```

## Notes

- live product data is pulled from the existing Bitvoya API base URL
- `BITVOYA_API_BEARER_TOKEN` is optional today, but the hook is ready if protected upstream endpoints are added later
- `BITVOYA_MCP_DB_*` should point at `tripwiki_publish` and remain read-only for grounding / enrichment
- `BITVOYA_MCP_AUTH_DB_*` should point at the Bitvoya account/auth database that owns `mcp_agent_tokens`
- if `BITVOYA_MCP_AUTH_DB_*` is omitted, the runtime falls back to `BITVOYA_MCP_DB_*`, but production should keep the auth DB separate
- `BITVOYA_MCP_TRANSPORT=stdio` keeps the repo in local process-spawned mode
- `BITVOYA_MCP_TRANSPORT=streamable_http` enables the public remote gateway path
- the current remote gateway runs stateless Streamable HTTP on `BITVOYA_MCP_HTTP_HOST:BITVOYA_MCP_HTTP_PORT`
- `BITVOYA_MCP_HTTP_PATH` is the MCP endpoint path and `BITVOYA_MCP_HTTP_HEALTH_PATH` exposes a simple health response
- `BITVOYA_MCP_BOOKING_EXECUTION_MODE` defaults to `executor_handoff`
- `executor_handoff` exposes only `prepare_booking_quote`, `create_booking_intent`, and `get_booking_state`
- `internal_execution` additionally exposes `attach_booking_card`, `submit_booking_intent`, `create_booking_payment_session`, and `refresh_booking_state`
- `BITVOYA_MCP_HANDOFF_MODE` controls public secure-handoff metadata:
  - `disabled`: no public secure-handoff flow advertised
  - `planned`: expose secure-handoff metadata but no launch URL
  - `signed_url`: emit signed hosted-checkout launch URLs when base URL and signing secret are configured
- `BITVOYA_MCP_HANDOFF_BASE_URL` should point to the Bitvoya-hosted secure checkout route for public agent completion
- `BITVOYA_MCP_HANDOFF_SIGNING_SECRET` signs short-lived booking-handoff launch tokens
- `BITVOYA_MCP_HANDOFF_TOKEN_TTL_SECONDS` controls launch URL lifetime
- `BITVOYA_MCP_REMOTE_AUTH_MODE=bearer` makes the remote gateway validate Bitvoya agent keys from `mcp_agent_tokens`
- `BITVOYA_MCP_REMOTE_AUTH_MODE=signed_principal` expects a trusted upstream gateway to inject a signed principal envelope
- `BITVOYA_MCP_REMOTE_AUTH_MODE=none` is only for isolated private testing and should not be used for public exposure
- `BITVOYA_MCP_REMOTE_PRINCIPAL_HEADER` and `BITVOYA_MCP_REMOTE_SIGNATURE_HEADER` are used for gateway-signed principal mode
- `BITVOYA_MCP_REMOTE_AUTH_SHARED_SECRET` is the HMAC secret shared between the remote gateway and the MCP runtime
- `BITVOYA_MCP_TOKEN_PEPPER` is an optional HMAC pepper for hashed agent-key verification
- `BITVOYA_MCP_REMOTE_AUTH_MAX_SKEW_SECONDS` limits replay window for the signed principal envelope
- `BITVOYA_MCP_REMOTE_REQUIRED_SCOPES` can enforce a minimum access floor before any MCP request is accepted
- `BITVOYA_MCP_STORE_PATH` keeps local quote / intent / encrypted-card runtime state
- quote / intent / card runtime state is bound to `user_id/account_id/token_id` so public remote requests stay account-scoped
- `BITVOYA_MCP_CARD_ENCRYPTION_KEY` is only required when `internal_execution` will use `attach_booking_card`
- for local `stdio` usage, inbound auth is effectively delegated to local machine trust
- for remote public usage, the SQL migration in [sql/001_mcp_auth_tables.sql](/root/bitvoya_mcp/sql/001_mcp_auth_tables.sql) should be applied so audit tables exist before launch
- secure public booking completion design lives in [docs/public/SECURE_HANDOFF.md](/root/bitvoya_mcp/docs/public/SECURE_HANDOFF.md)

## CI / GitHub Actions

The current regression workflow only runs `npm run check:syntax` in GitHub Actions.

- no database or API secrets are required for the current workflow
- live smoke remains a local/manual step via:
  - `npm run smoke:discovery`
  - `npm run smoke:booking`
  - `npm run smoke:all`
