# Bitvoya MCP

Luxury hotel intelligence and secure checkout handoff for AI travel agents.

Bitvoya MCP gives agents a clean way to search high-end hotels, compare rates, explain benefits, prepare booking quotes, and hand travelers back to Bitvoya for secure completion.

Normal users connect to the hosted MCP. No self-hosting is required.

## Why Bitvoya MCP

- one hosted endpoint for agent access
- live hotel, room, and rate discovery
- grounded city and hotel context
- explicit pricing semantics for agents
- secure booking handoff back to Bitvoya

## Built For

- AI travel assistants
- concierge and planning agents
- luxury hotel recommendation workflows
- member-facing travel copilots
- Bitvoya-connected partner agents

## Quick Start

Connection flow:

1. Sign in to your Bitvoya account at `https://bitvoya.com`
2. Open Dashboard -> Connect Agent:
   - `https://bitvoya.com/dashboard/agent-keys`
3. Create a named agent connection
4. Paste the hosted MCP endpoint into your client:
   - `https://bitvoya.com/api/mcp`
5. Add your header:
   - `Authorization: Bearer <your_agent_key>`
6. Test a tool such as `search_hotels`

Example configuration:

```json
{
  "type": "streamable_http",
  "url": "https://bitvoya.com/api/mcp",
  "headers": {
    "Authorization": "Bearer <your_agent_key>"
  }
}
```

## What Agents Can Do

Bitvoya MCP is designed for agentic travel discovery and booking preparation.

- live luxury hotel search
- hotel detail, media, and nearby context
- room and rate comparison
- explicit pricing semantics
- booking quote preparation
- booking intent creation
- secure checkout handoff back to Bitvoya

Core tools:

- `search_hotels`
- `get_hotel_detail`
- `get_hotel_rooms`
- `compare_hotels`
- `compare_rates`
- `prepare_booking_quote`
- `create_booking_intent`
- `get_booking_state`

## Booking Journey

Bitvoya intentionally keeps sensitive execution on Bitvoya-hosted surfaces.

Agents can:

- discover hotels and rates
- compare benefits, cancellation rules, and pricing
- prepare a booking quote
- create a booking intent
- poll booking state

Agents do not directly own:

- raw card entry
- payment execution
- final supplier-facing booking submission

That means the agent can do the discovery and booking-preparation work, while the traveler finishes card entry and final checkout on Bitvoya.

## Price Fields

Agents should present price fields carefully.

- search-stage output may include `supplier_min_price_cny` as an indicative search price
- final room/rate evaluation comes from `get_hotel_rooms`
- `get_hotel_rooms` returns:
  - `supplier_total_cny`
  - `service_fee_cny`
  - `display_total_cny`
- `display_total_cny` is the guest-facing total aligned with current Bitvoya product behavior

## Setup Guides

- client setup: [docs/public/CLIENT_SETUP.md](/root/bitvoya_mcp/docs/public/CLIENT_SETUP.md)
- frequently asked questions: [docs/public/FAQ.md](/root/bitvoya_mcp/docs/public/FAQ.md)
- security and access model: [docs/public/SECURITY_MODEL.md](/root/bitvoya_mcp/docs/public/SECURITY_MODEL.md)
- secure checkout handoff design: [docs/public/SECURE_HANDOFF.md](/root/bitvoya_mcp/docs/public/SECURE_HANDOFF.md)

## Important Notes

- Bitvoya calls this flow `Connect Agent`
- the generated credential is a revocable agent key
- website login credentials and MCP credentials are not the same thing
- multiple agent keys under one Bitvoya user still map to the same Bitvoya account history
- normal users connect to the hosted MCP and do not need direct database or server configuration

## Development

Maintainers and contributors can use [DEVELOPMENT.md](/root/bitvoya_mcp/DEVELOPMENT.md).
