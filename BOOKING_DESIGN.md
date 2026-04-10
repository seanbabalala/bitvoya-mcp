# Booking Design

This document defines the next MCP phase after discovery and content output are in place.

## Current Implementation Status

Implemented in this repo now:

- `prepare_booking_quote`
- `create_booking_intent`
- `attach_booking_card`
- `submit_booking_intent`
- `create_booking_payment_session`
- `refresh_booking_state`
- `get_booking_state`

Current behavior:

- quote and intent are owned by the MCP runtime store
- guarantee card data is encrypted before persistence in the local runtime store
- booking submission bridges into the existing `/booking/submit` endpoint using a regenerated legacy payload
- payment session creation bridges into `/payment/stripe/create-session`
- order refresh bridges into `/booking/{orderId}/details`

Still intentionally not done:

- public / partner-safe hosted card capture flow
- idempotency keys across distributed remote deployments
- booking handoff orchestration outside Bitvoya-controlled trust boundaries

## Benefits Coverage

Hotel benefit and promotion data is already exposed before booking:

- `search_hotels`
  - `membership_benefits.has_member_benefits`
  - `membership_benefits.top_interests`
  - `membership_benefits.top_promotions`
- `get_hotel_detail`
  - `hotel.membership_benefits`
  - `hotel_detail.benefits.interests`
  - `hotel_detail.benefits.promotions`
- `get_hotel_profile`
  - inherits `get_hotel_detail` normalized hotel + benefit output
- `get_hotel_rooms`
  - per-rate `benefits.interests`
  - per-rate `benefits.promotions`

This means the agent can already see:

- hotel-level member benefits
- rate-level benefits and promotions
- which specific rate carries which benefit package

## Current Web / Backend Flow

Observed current production pattern:

1. Frontend gets live room/rate data from `/hotels/rooms`
2. User submits `/booking/submit`
3. Backend creates order immediately
4. Payment happens afterwards
   - `full_payment` for prepay
   - `service_fee_only` for guarantee-with-service-fee
5. Payment select page calls `/payment/stripe/create-session`

Important current semantics:

- prepay:
  - order is created first
  - Stripe pays full booking amount afterwards
- guarantee with service fee:
  - order is created first
  - service fee is charged now
  - supplier amount is effectively pay-at-hotel
- guarantee without service fee:
  - order may complete without immediate Stripe payment

## Current Backend Facts

Relevant current endpoints:

- `/booking/submit`
- `/booking/create-session`
- `/booking/guarantee-success`
- `/payment/stripe/create-session`
- `/booking/{orderId}/details`

Observed current payload behavior:

- backend persists `interests` and `promotions` into booking snapshot
- backend persists `payment_type_data`
- backend persists guarantee credit card info in encrypted storage
- backend uses:
  - `rateDetail.totalPriceCny`
  - `rateDetail.total_with_service_fee`
  - `serviceFeeAmount`
  - `guestInfo.paymentMethod`
  - `flowType`

## Current Risks

These are the main issues before exposing booking to MCP:

1. No real server-side pre-check step
   - route `/booking/pre-check` exists in router
   - `BookingController::preCheck()` does not exist
   - route `/booking/checkAvailability` also appears wired conceptually, but the controller method is missing too

2. Backend trusts client-submitted price snapshot too much
   - current order creation uses frontend-provided `rateDetail`
   - this is acceptable for a normal website flow but too weak for agent-driven booking

3. Order is created before payment
   - useful for current UX
   - but agent integrations need clear idempotency and expiration semantics

4. Credit card data must not flow through third-party agents
   - current backend can store encrypted guarantee card data
   - remote MCP must not ask general-purpose agents to pass raw PAN/CVV unless the agent is fully trusted and the transport is hardened

5. Guarantee and points logic is special-case heavy
   - guarantee orders reject points deduction
   - service fee and supplier amount split must stay explicit

## MCP Booking Principles

The MCP booking layer should not directly mirror the current frontend submit payload.

Instead it should add a stricter server-owned booking pipeline:

1. quote
   - re-fetch live rate from Bitvoya API
   - validate hotel, room, rate, dates, occupancy
   - recompute supplier total, service fee, display total
   - freeze a short-lived quote id

2. intent
   - create a booking intent from a valid quote
   - attach guest profile data
   - attach selected payment path
   - do not require payment execution in the same step

3. payment session
   - create hosted payment session only when needed
   - never expose raw gateway secrets through MCP

4. card binding
   - attach guarantee card data or a secure card reference
   - keep card collection channel separate from generic booking fields

5. confirmation / status
   - poll intent or order state
   - clearly distinguish:
     - quote state
     - order state
     - payment state
     - guarantee state

## Recommended MCP Tool Contract

Phase 1 should use these tools:

### `prepare_booking_quote`

Purpose:

- server-side pre-check and quote freeze

Inputs:

- `hotel_id`
- `room_id`
- `rate_id`
- `checkin`
- `checkout`
- `adult_num`
- `child_num`
- `room_num`
- optional:
  - `user_id`
  - `membership_tier`
  - `lang`

Outputs:

- `quote_id`
- `expires_at`
- `hotel_snapshot`
- `room_snapshot`
- `rate_snapshot`
- `benefits_snapshot`
- `pricing`
  - `supplier_total_cny`
  - `service_fee_cny`
  - `display_total_cny`
- `payment_options`
  - `prepay_supported`
  - `guarantee_supported`
- `guarantee_policy`
- `cancellation_policy`
- `validation_flags`

Notes:

- this should be the first real MCP booking gate
- it should become the source of truth for later steps

### `create_booking_intent`

Purpose:

- create an internal order/intention from a valid quote

Inputs:

- `quote_id`
- `guest_primary`
- `companions`
- `children`
- `contact`
- `arrival_time`
- `special_requests`
- `payment_method`
- optional:
  - `loyalty_identifiers`
  - `agent_reference`

Outputs:

- `intent_id`
- `order_id`
- `status`
- `payment_requirement`
  - `none`
  - `full_payment`
  - `service_fee_only`
- `amount_due_now`
- `amount_due_at_hotel`

Notes:

- use quote snapshot, not raw client-submitted pricing
- persist `interests` and `promotions` from quote into order snapshot

### `attach_booking_card`

Purpose:

- attach the guarantee card required by supplier / hotel flows

Inputs:

- `order_id`
- either:
  - `card_reference_id`
  - or `card_payload`

`card_payload` minimum:

- `pan`
- `expiry`
- `cardholder_name`
- optional:
  - `brand`
  - `last4`

Outputs:

- `card_binding_status`
- `card_reference_id`
- `supplier_ready`
- `storage_mode`

Notes:

- supplier requirement means PAN + expiry must exist somewhere in Bitvoya-controlled flow
- CVV should not be stored after authorization or after the specific use for which it was collected
- recommended default:
  - public / third-party agent gets only `card_reference_id`
  - private / first-party trusted agent may use direct `card_payload`

### `create_booking_payment_session`

Purpose:

- create hosted payment page when required

Inputs:

- `order_id`
- `payment_channel`

Outputs:

- `payment_type`
- `session_url`
- `expires_at`

Notes:

- for prepay: `full_payment`
- for guarantee with service fee: `service_fee_only`
- use this only when immediate payment is required
- for guarantee orders with service fee:
  - card attachment and service-fee payment are two different steps

### `get_booking_state`

Purpose:

- status polling for agent orchestration

Outputs:

- `order_status`
- `payment_status`
- `payment_required`
- `guarantee_status`
- `next_action`

## What Should Not Be In MCP

These should stay out of general remote agent scope:

- raw credit card PAN collection for untrusted or third-party agents
- direct encrypted card storage requests from untrusted third-party agents
- opaque frontend-only payload shapes
- price fields with ambiguous semantics such as generic `price`

## Card Data Strategy

There are two deployment modes.

### Mode A: trusted private MCP

Use this only for Bitvoya-controlled agents and infrastructure.

Allowed:

- MCP receives PAN + expiry directly
- backend encrypts PAN immediately
- MCP returns only references and status

Requirements:

- strong auth
- strict scopes
- no prompt / trace / analytics logging of raw PAN
- field-level redaction in logs
- encrypted storage
- minimal retention

### Mode B: partner / third-party agent MCP

Recommended default for any external agent ecosystem.

Allowed:

- agent creates quote
- agent creates booking intent
- Bitvoya-hosted secure capture flow collects PAN + expiry
- MCP receives only `card_reference_id`

Benefits:

- much smaller blast radius
- clearer PCI boundary
- easier to audit

## PCI / Compliance Notes

Relevant official PCI SSC guidance:

- PAN must be rendered unreadable when stored; expiration date does not itself need to be rendered unreadable, but if stored with PAN it is still in PCI scope and must be protected:
  - https://www.pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/does-cardholder-name-expiration-date-etc-need-to-be-rendered-unreadable-if-stored-in-conjunction-with-the-pan-primary-account-number/?_hsmi=364054903
- CVV / CVC may be collected when needed, but must not be stored after authorization:
  - https://www.pcisecuritystandards.org/faqs/are-merchants-allowed-to-request-card-verification-codes-values-from-cardholders/

Inference from the above:

- if raw PAN flows through remote MCP, that MCP path, its logs, and its hosting environment are effectively part of the cardholder-data environment
- therefore raw card support should be limited to Bitvoya-controlled trusted paths

## Current Prototype Status

Implemented in the MCP repo now:

- discovery and grounding tools
- `prepare_booking_quote`
- `create_booking_intent`
- `attach_booking_card`
- `submit_booking_intent`
- `create_booking_payment_session`
- `refresh_booking_state`
- `get_booking_state`

Current booking exposure model:

- default mode is `executor_handoff`
- public / partner MCP exposure stops at:
  - `prepare_booking_quote`
  - `create_booking_intent`
  - `get_booking_state`
- internal-only execution tools are exposed only in `internal_execution` mode:
  - `attach_booking_card`
  - `submit_booking_intent`
  - `create_booking_payment_session`
  - `refresh_booking_state`

Current limitations still remaining:

- remote bearer auth is scaffolded in config, but not yet enforced in a deployed gateway / transport
- no Bitvoya-hosted secure card-capture flow exists yet for partner mode
- quote / intent state is local runtime state, not yet a distributed multi-instance store
- idempotency and audit trails still need a production persistence layer

## Identity And Auth Principle

Bitvoya should use one identity model and multiple credential types.

This means:

- website login and MCP access must resolve to the same Bitvoya `user_id`
- website username / password must not be reused by third-party agents as the MCP credential
- MCP access should use a dedicated bearer token or API key created after website login
- both the website and MCP should derive authorization from the same account status, user role, and commercial entitlements

Recommended rule:

- same person
- same underlying Bitvoya account
- different credential format per channel

In practice:

- website:
  - username / password -> Bitvoya session or site JWT
- MCP:
  - user-created agent token -> bearer token presented to the remote MCP gateway

This preserves identity consistency without giving agents a reusable website password.

## Unified Principal Model

Every authenticated request, whether from the website or from MCP, should be normalized into one internal principal object.

Recommended principal fields:

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

Recommended `token_type` values:

- `site_session`
- `personal_api_key`
- `agent_api_key`
- `internal_service_token`

Recommended `actor_type` values:

- `human_user`
- `partner_agent`
- `bitvoya_managed_agent`
- `internal_service`

Important behavior:

- if the Bitvoya account is suspended, both website access and MCP access should fail
- if the user loses booking privileges or commercial access, both website checkout and MCP booking scopes should reflect that change
- if the user resets password or explicitly revokes API access, token revocation policy should be applied consistently

## Credential Separation

The MCP token should not be the same thing as the website password.

Recommended flow:

1. User logs into Bitvoya website with username / password.
2. User opens an `Agent / API Keys` page in Bitvoya account settings.
3. User creates a named MCP token.
4. Bitvoya binds that token to the same `user_id` and `account_id`.
5. Agent uses that token as `Authorization: Bearer <token>` against the remote MCP gateway.

Recommended token properties:

- name
- creator `user_id`
- `account_id`
- allowed scopes
- optional environment label
- creation time
- expiry time
- revocation status
- last-used time
- optional IP / gateway restrictions

Recommended token UX:

- users can list active tokens
- users can revoke tokens individually
- users can set expiry
- Bitvoya can revoke all tokens on risk events

## Remote Auth Architecture

Remote auth should sit in front of the MCP server, ideally in a gateway or thin auth layer.

Recommended request path:

1. Agent sends bearer token to Bitvoya MCP gateway.
2. Gateway validates the token.
3. Gateway resolves the token to the unified principal.
4. Gateway enforces coarse scope checks.
5. Gateway forwards trusted principal headers or context to the MCP runtime.
6. MCP runtime performs tool-level authorization and business checks.
7. Internal executor re-checks sensitive permissions before any submit or payment action.

Recommended gateway responsibilities:

- bearer token validation
- token revocation check
- expiry check
- account status check
- coarse scope enforcement
- rate limiting
- audit logging
- request correlation id generation

Recommended MCP runtime responsibilities:

- map tools to required scopes
- enforce resource ownership
- enforce booking-mode boundaries
- return safe handoff metadata instead of sensitive execution paths when scopes are insufficient

## Scope Matrix

Recommended initial scope model:

| Scope | Allows | Notes |
| --- | --- | --- |
| `inventory.read` | hotel search, hotel detail, rooms, media, nearby, comparison | safe read scope |
| `grounding.read` | city / hotel grounding and content enrichment | safe read scope |
| `quote.write` | `prepare_booking_quote` | creates short-lived quote state |
| `intent.write` | `create_booking_intent` | creates booking intent only |
| `booking.state.read` | `get_booking_state` | read-only booking progress inspection |
| `card.capture.create` | create Bitvoya-hosted secure card-capture session | future hosted capture flow |
| `booking.execute` | internal executor actions only | never on normal public partner tokens |
| `token.manage` | create / revoke agent tokens from account UI or API | account-management scope |

Recommended default bundles:

- public / partner agent token:
  - `inventory.read`
  - `grounding.read`
  - `quote.write`
  - `intent.write`
  - `booking.state.read`
- Bitvoya-managed private agent token:
  - same as above
  - optional `card.capture.create`
  - `booking.execute` only if Bitvoya explicitly trusts that runtime and infrastructure
- internal service token:
  - `booking.execute`
  - `booking.state.read`
  - any additional internal operational scopes

Hard rule:

- `booking.execute` must not be included in the default token generated for external or partner agents

## Website And MCP Consistency Rules

The website and MCP do not need to share the same credential, but they do need to share the same account truth.

These behaviors should be consistent:

- account suspension disables both website checkout and MCP booking flows
- entitlement changes affect both website and MCP access
- order ownership is tied to the same `user_id` or `account_id`
- audit logs can trace both website actions and MCP actions back to the same principal

These behaviors should stay separate:

- website session cookie should not be the general MCP credential
- MCP bearer token should not log a user into the website frontend directly
- username / password should never be handed to a third-party agent

## Internal Executor Boundary

The internal executor is the Bitvoya-controlled fulfillment layer behind the public MCP.

It owns the sensitive actions that should not be directly exposed to third-party agents:

- guarantee card attachment
- backend booking submission
- payment-session creation
- order / payment refresh

Recommended boundary:

- public MCP:
  - search / compare / quote / intent / state
- internal executor:
  - card collection and secure binding
  - booking submit bridge
  - payment initiation
  - downstream sync and repair

Recommended executor entry rules:

- executor accepts only:
  - Bitvoya internal service tokens
  - or an internally signed handoff job created by trusted backend services
- executor does not accept arbitrary public partner tokens for raw submit or card actions

This is the core security split:

- public agent can prepare
- Bitvoya executor can fulfill

## Recommended Booking Flow By Trust Model

### Public / Partner Agent

1. Agent authenticates with a user-created MCP token.
2. Agent discovers hotels and rooms.
3. Agent calls `prepare_booking_quote`.
4. Agent calls `create_booking_intent`.
5. MCP returns:
   - intent state
   - handoff boundary
   - internal executor ownership of the next step
6. Bitvoya secure flow or human UI collects any missing card data.
7. Internal executor submits and creates payment session if required.
8. Agent or UI polls `get_booking_state`.

### Bitvoya-Managed Private Agent

1. Agent authenticates with a Bitvoya-issued private token.
2. Same discovery / quote / intent flow happens.
3. If Bitvoya explicitly enables trusted execution:
   - internal execution tools may be exposed
4. Raw PAN handling remains allowed only inside Bitvoya-controlled infrastructure with redaction and retention controls.

## Hosted Card Capture Recommendation

For partner-safe booking completeness, Bitvoya should add a hosted secure card capture flow.

Recommended shape:

- MCP or website asks Bitvoya backend to create a card-capture session
- Bitvoya returns a hosted URL
- traveler enters PAN + expiry on Bitvoya-controlled page
- Bitvoya stores encrypted card data or tokenizes it internally
- booking intent gets a `card_reference_id`
- public MCP never receives raw PAN

Recommended future tool:

- `create_card_capture_session`

Inputs:

- `intent_id`
- optional `return_url`

Outputs:

- `capture_session_id`
- `capture_url`
- `expires_at`
- `intent_id`

Required scope:

- `card.capture.create`

## Recommended Data Model For Tokens

Suggested fields for a persistent token table:

- `token_id`
- `account_id`
- `user_id`
- `token_name`
- `token_type`
- `actor_type`
- `token_hash`
- `scopes_json`
- `created_at`
- `expires_at`
- `revoked_at`
- `last_used_at`
- `created_by_ip`
- `last_used_ip`
- `notes`

Storage rule:

- store only a hash of the token secret
- display the raw token only once at creation time

## Revocation And Risk Policy

Recommended minimum policy:

- manual token revoke from account settings
- auto-expire tokens by default
- revoke all agent tokens on account compromise or severe fraud review
- optional revoke-all on password reset
- immediate deny if `account_status != active`

Recommended audit events:

- token created
- token revoked
- token used
- quote created
- intent created
- card capture session created
- executor submit started
- executor submit succeeded
- executor submit failed

## Recommended Rollout Order

1. Keep current default `executor_handoff` exposure.
2. Implement remote bearer auth in a gateway using the Bitvoya principal model.
3. Add token-management UI in the main Bitvoya account area.
4. Introduce scope enforcement per MCP tool.
5. Build hosted secure card capture for partner-safe guarantee flow.
6. Move quote / intent / card-reference state into a durable shared store.
7. Split internal executor into a dedicated service or tightly controlled internal path.
8. Add idempotency keys, audit dashboard, and risk controls.

## Immediate Product Decision

Recommended Bitvoya stance:

- main site username / password remains only for human login
- MCP uses dedicated user-created bearer tokens bound to the same Bitvoya account
- public / partner tokens stop at quote / intent / state
- internal executor owns raw card, submit, payment, and refresh
- if raw PAN must ever flow, it must stay inside Bitvoya-controlled trusted infrastructure only

This gives Bitvoya:

- one account system
- one commercial truth
- one audit trail
- separate credentials by channel
- secure default public MCP exposure
