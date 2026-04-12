# Bitvoya MCP FAQ

## Why do I need an agent key?

Bitvoya MCP is a protected hosted service.

The agent key lets Bitvoya:

- identify which Bitvoya account the request belongs to
- apply access policy
- revoke access safely if needed
- keep audit history per key

## Why not just use my Bitvoya username and password?

Your website login and your MCP access are intentionally different credentials.

That separation is safer because:

- you should not hand your website password to third-party agents
- agent access can be revoked without changing your website login
- each key can be tracked independently

## Is an agent key the same as my Bitvoya account?

No.

The key is only an access credential for MCP. It maps back to your Bitvoya account, but it is not your website login credential.

## If I create multiple keys, what happens?

Multiple keys under one Bitvoya user still map to the same Bitvoya account.

That means:

- your booking history stays under the same account
- your order history stays under the same account
- membership and entitlement state stay under the same account

What changes per key is mainly:

- revocation state
- audit trail
- which agent or client you gave the key to

## Should I use one key for every agent?

That is the recommended pattern.

Using one key per agent or client makes it easier to:

- revoke only one integration
- track usage cleanly
- avoid rotating all clients at once

## If the GitHub repo is public, does that mean the data is public?

No.

A public repository means the integration surface and docs are public. The live MCP service is still protected and requires a valid Bitvoya-issued agent key.

## What makes Bitvoya different from a generic hotel MCP?

Bitvoya is built around luxury and five-star hotel value, not just generic availability search.

Depending on hotel, rate, and stay dates, Bitvoya can surface premium value signals such as:

- room upgrade opportunities
- breakfast-included benefits
- early check-in or late checkout style perks
- hotel credit such as `USD 100` property credit
- long-stay offers such as `stay 3 pay 2` or `stay 4 pay 3`

The point is not only to find a room, but to help the agent explain why one luxury stay is better value than another.

## Does the agent key give direct database access?

No.

The key only gives access to the hosted MCP service according to Bitvoya policy. It does not expose raw database credentials or direct database access.

## Can the agent charge my card directly?

Not in the public hosted flow.

Bitvoya keeps sensitive steps on Bitvoya-hosted secure checkout surfaces, including:

- card entry
- payment handling
- final supplier-facing booking submission

## Why does the agent stop before final booking completion?

Because the public flow is designed to keep payment and card handling inside Bitvoya-controlled surfaces.

The agent can:

- discover hotels
- compare rates
- prepare a quote
- create a booking intent
- hand you into Bitvoya secure checkout

## Do I need to self-host Bitvoya MCP?

No, not for normal usage.

Most users should connect directly to:

- `https://bitvoya.com/api/mcp`

and authenticate with:

- `Authorization: Bearer <your_agent_key>`

## My MCP client asks for command and args instead of a URL. What should I do?

That usually means the client is trying to configure a local stdio server.

For Bitvoya hosted access, use the client's remote MCP mode and enter:

- URL: `https://bitvoya.com/api/mcp`
- Header: `Authorization: Bearer <your_agent_key>`

For step-by-step client instructions, see [docs/public/CLIENT_SETUP.md](CLIENT_SETUP.md).
