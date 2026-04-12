# Bitvoya MCP Booking Design

This document defines the booking-side operator design for Bitvoya MCP.

It is an implementation reference for Bitvoya maintainers, not a normal hosted-user setup guide.

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

## Current Web / Backend Flow

Observed current production pattern:

1. Frontend gets live room/rate data from `/hotels/rooms`
2. User submits `/booking/submit`
3. Backend creates order immediately
4. Payment happens afterwards
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

## Current Risks

These are the main issues before exposing booking to MCP:

1. No real server-side pre-check step
2. Backend trusts client-submitted price snapshot too much
3. Order is created before payment
4. Credit card data must not flow through third-party agents
5. Guarantee and points logic is special-case heavy

## MCP Booking Principles

The MCP booking layer should not directly mirror the current frontend submit payload.

Instead it should add a stricter server-owned booking pipeline:

1. quote
2. intent
3. payment session
4. card binding
5. confirmation / status

## Recommended MCP Tool Contract

Phase 1 uses these tools:

- `prepare_booking_quote`
- `create_booking_intent`
- `get_booking_state`

Sensitive execution tools stay reserved for trusted Bitvoya-controlled paths.
