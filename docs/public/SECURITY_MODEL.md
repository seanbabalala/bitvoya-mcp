# Bitvoya MCP Security and Access Model

This document describes how Bitvoya MCP access works in production.

It reflects the agreed direction:

- Bitvoya is already live, so auth design must be production-grade rather than MVP-only.
- A single Bitvoya user may create multiple agent keys.
- All keys under that Bitvoya user resolve to the same account view.
- Key-level isolation is for authentication, audit, and policy, not for splitting a user's bookings or order history.
- Sensitive execution remains behind Bitvoya-controlled boundaries even if discovery and intent flows are exposed to external agents.

## Canonical Identity Model

Bitvoya keeps one account truth.

Human website login and MCP access use different credentials, but they map to the same internal identity:

- website login:
  - username/password
  - site session / site JWT
- MCP access:
  - user-created agent key
  - remote bearer auth through Bitvoya MCP gateway

The canonical principal normalizes both channels into the same identity fields:

- `user_id`
- `account_id`
- `email`
- `user_role`
- `account_status`
- `commercial_plan`
- `token_id`
- `token_type`
- `actor_type`
- `scopes`
- `issued_at`
- `expires_at`

Important rule:

- agent keys do not become website login credentials
- website passwords must never be handed to third-party agents
- account suspension or entitlement downgrade must affect both website and MCP access consistently

## Multi-Key Account Semantics

Bitvoya supports many keys per user.

Current product rule:

- one user can create multiple agent keys
- those keys all bind to the same `user_id`
- those keys all bind to the same `account_id`
- all keys see the same booking history, order history, entitlements, and account-level state

What changes per key:

- `token_id`
- creation time
- expiry time
- revocation state
- audit trail
- optional future scope elevation for Bitvoya-managed infrastructure

What does not change per key:

- which Bitvoya account the key belongs to
- what bookings and orders belong to that account
- membership or entitlement state for that account

This is the central design choice: keys are separate credentials, not separate sub-accounts.

## Key Categories

### 1. User-Created Standard Key

This is the default key users create from the Bitvoya dashboard.

Properties:

- management: user-created
- actor type: `partner_agent`
- account view: shared with the user's Bitvoya account
- intended usage: external MCP clients and third-party agents

Default scopes:

- `inventory.read`
- `grounding.read`
- `quote.write`
- `intent.write`
- `booking.state.read`

This is the standard profile for current user-created keys.

### 2. Bitvoya-Managed Private Key

This key is for Bitvoya-controlled agent infrastructure.

Properties:

- management: Bitvoya-managed
- actor type: `bitvoya_managed_agent`
- account view: still shared with the bound Bitvoya account

Possible scopes:

- standard user-created key scopes
- optionally `card.capture.create`

This profile exists so Bitvoya can operate private agent flows without exposing sensitive execution to general external agents.

### 3. Internal Service Key

This key is never user-created.

Properties:

- management: internal only
- actor type: `internal_service`
- intended usage: executor services, secure handoff workers, operational backends

Possible scopes:

- `inventory.read`
- `grounding.read`
- `quote.write`
- `intent.write`
- `booking.state.read`
- `card.capture.create`
- `booking.execute`
- `token.manage`

## Scope Policy

Tool exposure rules:

- public discovery tools require read scopes only
- quote and intent tools require write scopes but remain public-facing
- state inspection remains read-only
- card and submit execution are separated from public agent access

Current scope meanings:

- `inventory.read`
  - hotel search, inventory, room/rate read paths
- `grounding.read`
  - city and hotel grounding, enrichment, content context
- `quote.write`
  - create quote state after live revalidation
- `intent.write`
  - create booking intent state
- `booking.state.read`
  - inspect quote/intent/order state
- `card.capture.create`
  - create Bitvoya-hosted secure card capture session
- `booking.execute`
  - internal-only submit and fulfillment execution
- `token.manage`
  - create/revoke keys via trusted account-management channels

Hard production rule:

- `booking.execute` must not be present on normal user-created keys

Secondary production rule:

- `token.manage` stays on trusted account-management paths, not on general user-created agent keys

## Data Visibility Model

For the current Bitvoya product, data is account-scoped rather than key-scoped.

That means:

- if a user creates key A and key B, both keys can retrieve the same account-owned booking state
- account history is the same no matter which valid key is used
- audit still preserves which specific `token_id` initiated which quote, intent, or state request

This gives Bitvoya the right user experience:

- users can experiment with multiple agents
- users do not lose their order continuity
- Bitvoya can still isolate abuse, leakage, or rate-limit issues to a single key

## Audit Model

Audit is key-specific even though data visibility is account-shared.

Minimum event binding:

- `event_id`
- `request_id`
- `token_id`
- `user_id`
- `account_id`
- `actor_type`
- `tool_name`
- `status`
- `reason_code`
- request context
- result context

Bitvoya keeps separate token, audit, and handoff records so access control and fulfillment history can be traced safely.

## Remote Production Topology

Public repository or public client compatibility does not imply open access.

Production path:

1. A Bitvoya user logs into the Bitvoya website.
2. The user opens Dashboard -> Connect Agent and creates an agent access credential.
3. The external agent sends that credential to the Bitvoya remote MCP gateway as a bearer token.
4. The gateway validates token hash, revocation, expiry, and account status.
5. The gateway resolves the token to the canonical principal.
6. The gateway forwards a signed principal envelope to the MCP runtime.
7. The MCP runtime enforces tool-level scope policy and booking-mode boundaries.
8. Sensitive fulfillment actions remain inside Bitvoya-controlled internal executor paths.

Implication:

- the repo can be public
- the MCP service is still protected
- valid Bitvoya-issued credentials remain mandatory

## Booking Security Boundary

Current booking design is intentionally split:

- external/public MCP:
  - discovery
  - quote
  - intent
  - state
- internal Bitvoya executor:
  - secure card handling
  - supplier-facing submission
  - payment-session creation
  - downstream refresh or repair

This is why user-created standard keys stop before `booking.execute`.
