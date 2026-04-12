# Bitvoya MCP Secure Handoff

This document defines the public booking-completion pattern for Bitvoya MCP.

The goal is:

- let an external agent handle discovery, recommendation, quote, and intent creation
- keep raw card handling, payment handling, and supplier-facing submit steps inside Bitvoya-controlled surfaces
- make the final traveler journey still feel like booking through the agent

## Product Position

Public agents should not receive:

- raw PAN
- expiry input
- direct booking submit capability
- direct payment-session execution capability

Public agents should be able to:

- search cities and hotels
- compare rates and explain benefits
- create a short-lived booking quote
- create a booking intent
- launch a Bitvoya-hosted secure handoff surface
- poll booking state after handoff

## Canonical Public Flow

### 1. Agent Discovery

The agent uses:

- `search_hotels`
- `get_hotel_detail`
- `get_hotel_rooms`
- `compare_hotels`
- `compare_rates`

The agent explains:

- `display_total_cny`
- `supplier_total_cny`
- `service_fee_cny`
- benefits
- cancellation window
- payment path semantics

### 2. Quote

The agent calls:

- `prepare_booking_quote`

This freezes:

- hotel
- room
- rate
- stay dates
- normalized pricing semantics

### 3. Intent

The agent calls:

- `create_booking_intent`

This records:

- traveler primary guest
- contact details
- optional companions / children
- chosen `payment_method`
- quote snapshot

At this point the public agent has done enough.

### 4. Secure Handoff

The traveler continues on Bitvoya-hosted secure checkout.

That hosted surface owns:

- guarantee card entry
- hosted payment confirmation
- internal submit orchestration
- post-submit state display

### 5. Internal Executor

Behind the handoff page, Bitvoya internal executor performs:

- card binding or secure card reference creation
- legacy backend submission
- payment-session creation when needed
- downstream refresh / reconciliation

### 6. Agent State Polling

After handoff begins, the agent continues with:

- `get_booking_state`

This gives the agent:

- quote state
- order state
- payment state
- guarantee state
- handoff state

## Why This Is The Right Public Pattern

It preserves:

- safe public MCP
- high-conversion agent UX
- no raw card in agent chat
- no need to rewrite old booking backend APIs
- one consistent account/order history per Bitvoya user

## Secure Handoff Surface

Recommended surface:

- Bitvoya-hosted web checkout

Recommended properties:

- mobile-friendly
- can be opened from chat apps or agent clients
- supports authenticated resume
- shows hotel, room, rate, stay, and pricing snapshot
- clearly shows `display_total_cny` vs `service_fee_cny` vs pay-at-hotel amount

### Prepay

Traveler should:

- confirm guest details
- complete hosted payment

Bitvoya internal services should:

- create payment session
- submit or finalize booking in the correct order
- sync downstream state

### Guarantee

Traveler should:

- confirm guest details
- enter card number and expiry only on Bitvoya-hosted page
- complete any hosted service-fee payment if required

Bitvoya internal services should:

- attach card securely
- submit booking to legacy backend
- sync downstream state

## Handoff Token Model

The MCP layer scaffolds a signed-URL pattern for public release.

Recommended token properties:

- short TTL
- signed with Bitvoya secret
- bound to one `intent_id`
- no raw card data
- no reusable login credential

Recommended claims:

- `type=booking_intent_handoff`
- `intent_id`
- `quote_id`
- `payment_method`
- `amount_due_now_cny`
- `amount_due_at_hotel_cny`
- `requires_card_attachment`
- `user_id`
- `account_id`
- `email`
- `iat`
- `exp`
- nonce

## MCP Output Contract

Public booking responses should expose stable `secure_handoff` metadata.

That object answers:

- is handoff enabled
- what state the handoff is in
- whether traveler action is required
- whether a signed launch URL is configured
- who owns card input
- who owns payment input
- which tool should be used for status polling afterward
