# Bitvoya MCP

Hosted MCP for luxury hotel discovery, hotel evaluation, booking quote preparation, and secure checkout handoff.

This repository is the MCP-facing layer for Bitvoya. It is the public integration surface, not the Bitvoya website or legacy booking backend.

## Hosted Connection

Travelers and agent users connect to the Bitvoya-hosted MCP, not to a self-managed database.

Connection flow:

1. Sign in to your Bitvoya account at `https://bitvoya.com`
2. Open Dashboard -> Connect Agent:
   - `https://bitvoya.com/dashboard/agent-keys`
3. Create a named agent connection
4. Paste the hosted MCP values into your MCP client:
   - endpoint: `https://bitvoya.com/api/mcp`
   - auth header: `Authorization: Bearer <your_agent_key>`
5. Test a discovery tool such as `search_hotels`

Example client shape:

```json
{
  "type": "streamable_http",
  "url": "https://bitvoya.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <your_agent_key>"
  }
}
```

Important:

- Bitvoya calls this flow `Connect Agent`
- the generated credential is a revocable agent key
- website login credentials and MCP credentials are not the same thing
- multiple agent keys under one Bitvoya user still map to the same Bitvoya account history

## What Agents Can Do

The hosted MCP is designed for agent-friendly hotel discovery and booking preparation.

Core discovery tools:

- `search_hotels`
- `get_hotel_detail`
- `get_hotel_rooms`
- `compare_hotels`
- `compare_rates`

Grounding and enrichment tools:

- `search_cities`
- `get_city_grounding`
- `get_hotel_grounding`
- `get_nearby_hotels`
- `get_hotel_media`

Booking-preparation tools:

- `prepare_booking_quote`
- `create_booking_intent`
- `get_booking_state`

## Booking Boundary

Bitvoya intentionally keeps sensitive execution on Bitvoya-hosted surfaces.

External agents can:

- discover hotels and rates
- compare benefits, cancellation rules, and pricing
- prepare a booking quote
- create a booking intent
- poll booking state

External agents do not directly own:

- raw card entry
- payment session execution
- final supplier-facing booking submission

For public usage, card collection and payment completion happen on a Bitvoya-hosted secure checkout surface.

## Pricing Semantics

Agents should present price fields carefully.

- search-stage output may include `supplier_min_price_cny` as an indicative search price
- final room/rate evaluation comes from `get_hotel_rooms`
- `get_hotel_rooms` returns:
  - `supplier_total_cny`
  - `service_fee_cny`
  - `display_total_cny`
- `display_total_cny` is the guest-facing total aligned with current Bitvoya product behavior

## Public Reference Docs

- security and access model: [docs/public/SECURITY_MODEL.md](/root/bitvoya_mcp/docs/public/SECURITY_MODEL.md)
- secure checkout handoff design: [docs/public/SECURE_HANDOFF.md](/root/bitvoya_mcp/docs/public/SECURE_HANDOFF.md)

## Operator Docs

These are for Bitvoya operators and maintainers, not normal hosted MCP users.

- runtime configuration: [docs/operators/CONFIGURATION.md](/root/bitvoya_mcp/docs/operators/CONFIGURATION.md)
- live deployment: [docs/operators/DEPLOYMENT.md](/root/bitvoya_mcp/docs/operators/DEPLOYMENT.md)
- booking implementation notes: [docs/operators/BOOKING_DESIGN.md](/root/bitvoya_mcp/docs/operators/BOOKING_DESIGN.md)

## Local Contribution

```bash
cd /root/bitvoya_mcp
npm install
npm run start
```

For local stdio development, point the MCP client at:

- command: `node`
- args: `["/root/bitvoya_mcp/src/server.mjs"]`

Local operator setup, remote gateway config, and live release flow are documented in the operator docs above.
