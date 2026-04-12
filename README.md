# Bitvoya MCP

API-first MCP server for Bitvoya luxury hotel discovery with `tripwiki_publish` grounding augmentation.

## Public Onboarding

GitHub should explain client-side setup. It is not where a traveler applies for credentials.

Public connection flow:

1. Sign in to your Bitvoya account at `https://bitvoya.com`
2. Open Dashboard -> Connect Agent:
   - `https://bitvoya.com/dashboard/agent-keys`
3. Create a named agent connection
4. Paste the hosted MCP values into your client:
   - endpoint: `https://bitvoya.com/api/mcp`
   - header: `Authorization: Bearer <your_agent_access_token>`
5. Save the connection and test a discovery tool such as `search_hotels`

Important:

- Bitvoya calls this flow `Connect Agent` in the dashboard
- under the hood, the generated credential is still a revocable per-agent bearer key
- bookings, booking history, and membership stay bound to the same Bitvoya account
- website login credentials and MCP credentials are not the same thing

## Live Deploy

Use [DEPLOYMENT.md](/root/bitvoya_mcp/DEPLOYMENT.md) as the source of truth for live MCP release flow.

Status:

```bash
cd /root/bitvoya_mcp
npm run deploy:remote -- --status
```

Release:

```bash
cd /root/bitvoya_mcp
npm run deploy:remote
```

Current scope:

- live hotel search from existing Bitvoya APIs
- live room / rate inventory from existing Bitvoya APIs
- explicit price semantics for supplier total vs service fee vs display total
- city / hotel grounding from `tripwiki_publish`
- nearby POI context for grounded city and hotel cards
- server-owned booking quote / intent workflow ahead of any backend submission
- secure-by-default executor handoff mode for public / partner agent usage
- optional trusted private-mode booking execution chain for Bitvoya-controlled agents
- agent-first structured tool envelopes with MCP-compatible `outputSchema` and read-only annotations on discovery/evaluation tools

## Runtime Config

Runtime credentials are loaded from:

- `/root/.config/bitvoya-mcp/server.env`

See [CONFIGURATION.md](/root/bitvoya_mcp/CONFIGURATION.md) for the expected keys.

Database split:

- `BITVOYA_MCP_DB_*`
  - `tripwiki_publish` grounding / enrichment data
- `BITVOYA_MCP_AUTH_DB_*`
  - Bitvoya account / auth data such as `mcp_agent_tokens`

Default booking mode is `executor_handoff`.

- public/default MCP exposure ends at:
  - `prepare_booking_quote`
  - `create_booking_intent`
  - `get_booking_state`
- secure checkout launch is currently surfaced through `data.secure_handoff`
  - there is no standalone public card-capture tool exposed yet
- internal-only booking execution tools are exposed only when:
  - `BITVOYA_MCP_BOOKING_EXECUTION_MODE=internal_execution`

Remote auth scaffolding in this repo now includes:

- tool-to-scope policy catalog in [src/authz.mjs](/root/bitvoya_mcp/src/authz.mjs)
- token generation / hashing helpers in [src/token-auth.mjs](/root/bitvoya_mcp/src/token-auth.mjs)
- bearer token verification and auth audit helpers in [src/agent-auth.mjs](/root/bitvoya_mcp/src/agent-auth.mjs)
- gateway-signed principal verification helpers in [src/remote-auth.mjs](/root/bitvoya_mcp/src/remote-auth.mjs)
- stateless Streamable HTTP gateway runtime in [src/remote-server.mjs](/root/bitvoya_mcp/src/remote-server.mjs)
- MySQL table scaffolding in [sql/001_mcp_auth_tables.sql](/root/bitvoya_mcp/sql/001_mcp_auth_tables.sql)
- production auth design in [AUTH_MODEL.md](/root/bitvoya_mcp/AUTH_MODEL.md)
- public secure-checkout handoff design in [SECURE_HANDOFF_DESIGN.md](/root/bitvoya_mcp/SECURE_HANDOFF_DESIGN.md)

## Tools

- default exposed booking tools:
  - `prepare_booking_quote`
  - `create_booking_intent`
  - `get_booking_state`
- internal-only booking execution tools:
  - `attach_booking_card`
  - `submit_booking_intent`
  - `create_booking_payment_session`
  - `refresh_booking_state`
- `search_cities`
- `search_destination_suggestions`
- `search_cities_live`
- `list_hot_cities`
- `get_city_grounding`
- `search_hotels`
- `get_hotel_detail`
- `get_hotel_profile`
- `get_hotel_rooms`
- `compare_hotels`
- `compare_rates`
- `get_hotel_media`
- `get_nearby_hotels`
- `get_hotel_collections`
- `list_seo_collections`
- `get_seo_collection`
- `get_featured_hotels`
- `search_hotels_grounding`
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

For remote/public MCP testing:

```bash
cd /root/bitvoya_mcp
BITVOYA_MCP_TRANSPORT=streamable_http \
BITVOYA_MCP_HTTP_HOST=127.0.0.1 \
BITVOYA_MCP_HTTP_PORT=3011 \
npm run start
```

- MCP endpoint: `http://127.0.0.1:3011/mcp`
- health endpoint: `http://127.0.0.1:3011/healthz`
- auth:
  - `bearer` mode expects `Authorization: Bearer btk_live_...`
  - `signed_principal` mode expects Bitvoya gateway-signed principal headers

## Smoke Scripts

- `npm run check:syntax`
  - runs `node --check` over the server, discovery/booking tools, and smoke scripts
- `npm run smoke:discovery`
  - validates hotel discovery, room/rate recommendation, hotel comparison, and rate comparison against live data
- `npm run smoke:booking`
  - validates quote, intent, card attachment, state inspection, submit, payment-session, and refresh flows
  - uses a temporary runtime store plus a fake submit/payment backend for the side-effecting steps
- `npm run smoke:all`
  - runs both discovery and booking smoke flows in sequence
- `npm run verify:agent-key -- --token <raw-agent-key>`
  - verifies a Bitvoya agent key against `mcp_agent_tokens`
  - reports `user_id`, `account_id`, lifecycle state, inferred key profile, and allowed tools under current policy
  - DB config resolution order is:
    - `BITVOYA_AGENT_KEYS_DB_*`
    - `BITVOYA_MCP_AUTH_DB_*`
    - `BITVOYA_MCP_DB_*`
- `npm run create:handoff -- --token <raw-agent-key>`
  - verifies the agent key, resolves the bound Bitvoya account, creates a real quote and booking intent, and prints `data.secure_handoff`
  - writes to the configured MCP runtime store so the hosted Bitvoya handoff page can resolve the generated `intent_id`
  - defaults to a known-good live inventory tuple, but supports overriding `hotel_id`, `room_id`, `rate_id`, stay dates, guest data, and `payment_method`

Example:

```bash
npm run create:handoff -- \
  --token <raw-agent-key> \
  --payment-method guarantee \
  --json
```

## GitHub Actions

- workflow file: [.github/workflows/regression.yml](/root/bitvoya_mcp/.github/workflows/regression.yml)
- triggers:
  - `push` to `main` or `master`
  - `pull_request`
  - `workflow_dispatch`
- behavior:
  - only the `Syntax` job runs automatically in GitHub
  - no database or API secrets are required for the current workflow
  - `smoke:*` scripts stay available for local/manual verification when needed

## Scope

This repository is the clean MCP-facing layer.

It should:

- keep Bitvoya's existing website / backend API contracts untouched
- use existing Bitvoya APIs for live product and inventory data
- use `tripwiki_publish` as a read-only grounding and enrichment layer
- expose stable, agent-friendly hotel and city tools
- keep price semantics explicit for agent consumers
- add a server-owned quote / intent layer before any real booking submission
- default public/partner MCP usage to quote / intent / state inspection only
- bridge into existing booking and payment APIs only inside explicitly enabled internal execution mode

It should not:

- own Bitvoya web UX
- own backend booking contracts
- expose raw sensitive guest data to untrusted agents
- expose card, submit, payment-session, or refresh execution tools by default

Exception:

- in trusted private MCP mode, guarantee-card data may be attached in encrypted form for later supplier / hotel transmission
- this is scaffolding for first-party Bitvoya-controlled agents, not a blanket pattern for every third-party agent
- payment execution still happens through the existing Bitvoya payment endpoints and hosted Stripe session flow

## Pricing Semantics

- `search_hotels` may return `supplier_min_price_cny` when stay dates are provided
- `supplier_min_price_cny` is a search-stage supplier quote from `/hotels/prices`
- final guest-facing totals must come from `get_hotel_rooms`
- `get_hotel_rooms` returns:
  - `supplier_total_cny`
  - `service_fee_cny`
  - `display_total_cny`
- `display_total_cny` mirrors current frontend behavior based on `total_with_service_fee`

## Preference-Aware Ranking

- `get_hotel_rooms`, `compare_hotels`, and `compare_rates` accept optional traveler-intent inputs:
  - `priority_profile`
  - `payment_preference`
  - `require_free_cancellation`
  - `prefer_benefits`
- `get_hotel_rooms` now returns an in-tool `selection_guide.recommended_rate` plus `top_recommendations`
- `compare_hotels` and `compare_rates` return `applied_preferences`, `comparison_method`, and per-row `score_breakdown`
- default behavior remains backward compatible when no preference inputs are supplied

## Booking Quote Gate

- `prepare_booking_quote` is the first booking-side execution gate and revalidates the selected `hotel_id + room_id + rate_id` against live inventory
- it now returns:
  - `quote`
  - `confirmation_pack`
  - `payment_paths.prepay`
  - `payment_paths.guarantee`
  - `required_inputs`
  - `booking_readiness`
  - `secure_handoff`
- agents should use `payment_paths` to choose `payment_method` for `create_booking_intent`
- in default `executor_handoff` mode, `payment_paths` also make the Bitvoya-internal fulfillment boundary explicit
- guarantee still requires card data eventually, but collection is reserved for Bitvoya-hosted secure checkout plus internal executor in default mode

## Booking Intent Execution

- `create_booking_intent` always returns an agentic execution envelope instead of a bare state object
- `attach_booking_card` is only exposed in `internal_execution` mode
- booking intent responses expose:
  - `data.intent`
  - `data.payment_overview`
  - `data.required_inputs`
  - `data.blocking_requirements`
  - `data.execution_boundary`
  - `data.execution_state`
  - `data.secure_handoff`
- `recommended_next_tools` is now the canonical way for an agent to continue the booking flow safely
- in default `executor_handoff` mode, external agents should stop after `create_booking_intent`, surface `data.secure_handoff` to the traveler, and only inspect later status with `get_booking_state`

## Public Gateway Notes

- the repo now supports both `stdio` and remote `streamable_http` transport
- remote requests are authenticated before MCP method handling begins
- in `bearer` mode, Bitvoya `agent key` lookup resolves `user_id/account_id/token_id/scopes` from `mcp_agent_tokens`
- runtime `quote`, `intent`, and stored `card_reference_id` records are now bound to the originating Bitvoya account
- this means multiple keys under the same Bitvoya user still share account history, but keys cannot cross into another account's runtime booking state
- if `mcp_auth_audit_events` has not been migrated yet, the gateway auto-disables audit writes and continues serving requests

## Submission And State

- `get_booking_state` always uses the same structured envelope style as the rest of booking
- `submit_booking_intent`, `create_booking_payment_session`, and `refresh_booking_state` are internal-only and share the same envelope style when internal execution is enabled
- intent-state responses now distinguish:
  - `quote_state`
  - `order_state`
  - `payment_state`
  - `guarantee_state`
- `get_booking_state` returns either a quote-state package or an intent-state package depending on the provided id
- in `executor_handoff` mode, state responses add both `execution_boundary` and `secure_handoff` so an external agent can see whether the traveler should enter Bitvoya-hosted secure checkout or simply keep polling state
- recommended public test loop is:
  - run `npm run create:handoff -- --token <raw-agent-key>`
  - open `secure_handoff.launch_url`
  - log in with the same Bitvoya account bound to that key
  - finish secure checkout on Bitvoya
  - use `get_booking_state` with the returned `intent_id`

## Auth Direction

- the canonical production auth/key model is documented in [AUTH_MODEL.md](/root/bitvoya_mcp/AUTH_MODEL.md)
- current transport is local `stdio`, so inbound auth is not enforced inside this repo
- any future remote MCP deployment must add bearer or gateway auth before exposure
- configuration scaffolding for remote auth lives in [CONFIGURATION.md](/root/bitvoya_mcp/CONFIGURATION.md)
- recommended remote pattern is:
  - website user logs in with Bitvoya account
  - user opens Dashboard -> Connect Agent and creates agent access
  - remote gateway validates bearer token and resolves unified principal
  - gateway forwards a signed principal envelope to the MCP runtime
  - MCP runtime enforces tool scopes and booking-mode boundaries
