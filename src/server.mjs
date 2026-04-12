import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  agenticToolOutputSchema,
  buildAgenticToolResult,
  buildNextTool,
  buildToolTextResult,
} from "./agentic-output.mjs";
import { getPrincipalFromAuthInfo, writeAuthAuditEvent } from "./agent-auth.mjs";
import { getServerAuthProfile } from "./auth.mjs";
import { evaluateToolAuthorization } from "./authz.mjs";
import { createBitvoyaApi } from "./bitvoya-api.mjs";
import { loadConfig, summarizeConfig } from "./config.mjs";
import { createDb } from "./db.mjs";
import { clampInteger, clampLimit } from "./format.mjs";
import { startRemoteServer } from "./remote-server.mjs";
import { createRuntimeStore } from "./runtime-store.mjs";
import {
  attachBookingCard,
  createBookingPaymentSession,
  createBookingIntent,
  getBookingState,
  prepareBookingQuote,
  refreshBookingState,
  submitBookingIntent,
} from "./tools/booking.mjs";
import { getCityGrounding, searchCities } from "./tools/cities.mjs";
import {
  getFeaturedHotels,
  getHotelCollections,
  getHotelMedia,
  getHotelProfile,
  getNearbyHotels,
  getSeoCollection,
  listHotCities,
  listSeoCollections,
  searchCitiesLive,
  searchDestinationSuggestions,
} from "./tools/content.mjs";
import {
  compareHotels,
  compareRates,
  getHotelDetail,
  getHotelGrounding,
  getHotelRooms,
  searchHotels,
  searchHotelsGrounding,
} from "./tools/hotels.mjs";

const config = loadConfig();
const db = createDb(config);
const authDb = createDb(config, {
  section: "authDb",
  poolKey: "bitvoya-mcp-auth",
});
const api = createBitvoyaApi(config);
const authProfile = getServerAuthProfile(config);
const store = createRuntimeStore(config);
const bookingExecutionMode = config.bookingExecution.mode;
const internalExecutionEnabled = bookingExecutionMode === "internal_execution";
const enforceRemoteAuth =
  config.server.transport !== "stdio" && config.remoteAuth.mode !== "none";
let authAuditEnabled = true;
const serverInfo = {
  name: config.server.name,
  version: config.server.version,
};
let remoteServer = null;

function asTextResult(payload) {
  return buildToolTextResult(payload);
}

function agenticReadTool(config) {
  return {
    ...config,
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      ...(config.annotations || {}),
    },
  };
}

const hotelComparisonPriorityProfileSchema = z.enum([
  "balanced",
  "price",
  "perks",
  "luxury",
  "location",
  "flexibility",
  "low_due_now",
]);

const rateComparisonPriorityProfileSchema = z.enum([
  "balanced",
  "price",
  "perks",
  "flexibility",
  "low_due_now",
]);

const paymentPreferenceSchema = z.enum(["any", "prepay", "guarantee"]);

function buildRequestAuditContext(extra) {
  const headers = extra?.requestInfo?.headers || {};

  return {
    url: extra?.requestInfo?.url ? String(extra.requestInfo.url) : null,
    mcp_session_id: headers["mcp-session-id"] || null,
    transport: config.server.transport,
  };
}

function extractRequestIp(extra) {
  const headers = extra?.requestInfo?.headers || {};
  const forwardedFor = headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  const realIp = headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim();
  }

  return null;
}

function describeAuthorizationFailure(toolName, authorization) {
  const missingScopes =
    authorization?.missing_scopes && authorization.missing_scopes.length > 0
      ? ` Missing scopes: ${authorization.missing_scopes.join(", ")}.`
      : "";

  return `Bitvoya principal is not authorized for ${toolName}. Reason: ${authorization?.reason || "unknown"}.${missingScopes}`;
}

function resolveToolResourceAccess(args) {
  if (!args || typeof args !== "object") {
    return {
      accountId: null,
      bindingRequired: false,
      bindingMissing: false,
      resourceType: null,
      resourceId: null,
    };
  }

  if (args.intent_id) {
    const intent = store.getIntent(args.intent_id);
    return {
      accountId: intent?.account_binding?.account_id || null,
      bindingRequired: Boolean(intent),
      bindingMissing: Boolean(intent && !intent?.account_binding?.account_id),
      resourceType: "intent",
      resourceId: String(args.intent_id),
    };
  }

  if (args.quote_id) {
    const quote = store.getQuote(args.quote_id);
    return {
      accountId: quote?.account_binding?.account_id || null,
      bindingRequired: Boolean(quote),
      bindingMissing: Boolean(quote && !quote?.account_binding?.account_id),
      resourceType: "quote",
      resourceId: String(args.quote_id),
    };
  }

  if (args.card_reference_id) {
    const card = store.getCard(args.card_reference_id);
    return {
      accountId: card?.account_binding?.account_id || null,
      bindingRequired: Boolean(card),
      bindingMissing: Boolean(card && !card?.account_binding?.account_id),
      resourceType: "card_reference",
      resourceId: String(args.card_reference_id),
    };
  }

  return {
    accountId: null,
    bindingRequired: false,
    bindingMissing: false,
    resourceType: null,
    resourceId: null,
  };
}

async function auditToolCall(toolName, extra, payload = {}) {
  if (!authAuditEnabled || !enforceRemoteAuth || !extra?.authInfo) {
    return;
  }

  const principal = getPrincipalFromAuthInfo(extra.authInfo);
  if (!principal) {
    return;
  }

  try {
    await writeAuthAuditEvent(authDb, {
      principal,
      event_type: "tool_call",
      tool_name: toolName,
      status: payload.status || "allowed",
      reason_code: payload.reason_code || null,
      ip_address: extractRequestIp(extra),
      user_agent: extra?.requestInfo?.headers?.["user-agent"] || null,
      request_context: {
        ...buildRequestAuditContext(extra),
        ...(payload.request_context || {}),
      },
      result_context: payload.result_context || {},
    });
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      authAuditEnabled = false;
      console.error(
        "mcp_auth_audit_events table is missing in the configured auth database. Disabling MCP audit writes until the migration is applied."
      );
      return;
    }

    console.error(`Failed to audit tool ${toolName}:`, error?.message || error);
  }
}

function wrapToolHandler(toolName, handler) {
  return async (...callArgs) => {
    const hasArgs = callArgs.length === 2;
    const args = hasArgs ? callArgs[0] : undefined;
    const extra = (hasArgs ? callArgs[1] : callArgs[0]) || {};
    const principal = getPrincipalFromAuthInfo(extra.authInfo);
    const resourceAccess = resolveToolResourceAccess(args);

    if (enforceRemoteAuth) {
      if (resourceAccess.bindingMissing) {
        await auditToolCall(toolName, extra, {
          status: "denied",
          reason_code: "resource_binding_missing",
          request_context: {
            resource_type: resourceAccess.resourceType,
            resource_id: resourceAccess.resourceId,
          },
        });
        throw new Error(
          `Bitvoya ${resourceAccess.resourceType || "resource"} ${resourceAccess.resourceId || ""} is not bound to an account and cannot be used through the public MCP gateway.`
        );
      }

      const authorization = evaluateToolAuthorization(principal, toolName, {
        bookingExecutionMode,
        resourceAccountId: resourceAccess.accountId,
      });

      if (!authorization.allowed) {
        await auditToolCall(toolName, extra, {
          status: "denied",
          reason_code: authorization.reason,
          request_context: {
            resource_type: resourceAccess.resourceType,
            resource_id: resourceAccess.resourceId,
            resource_account_id: resourceAccess.accountId,
          },
          result_context: {
            missing_scopes: authorization.missing_scopes,
          },
        });
        throw new Error(describeAuthorizationFailure(toolName, authorization));
      }
    }

    const nextExtra = {
      ...extra,
      bitvoyaAuth: {
        principal,
        resourceAccountId: resourceAccess.accountId,
      },
    };

    try {
      const result = hasArgs ? await handler(args, nextExtra) : await handler(nextExtra);
      await auditToolCall(toolName, extra, {
        status: "allowed",
        reason_code: "authorized",
        request_context: {
          resource_type: resourceAccess.resourceType,
          resource_id: resourceAccess.resourceId,
          resource_account_id: resourceAccess.accountId,
        },
      });
      return result;
    } catch (error) {
      await auditToolCall(toolName, extra, {
        status: "error",
        reason_code: "handler_error",
        request_context: {
          resource_type: resourceAccess.resourceType,
          resource_id: resourceAccess.resourceId,
          resource_account_id: resourceAccess.accountId,
        },
        result_context: {
          message: error?.message || String(error),
        },
      });
      throw error;
    }
  };
}

function createMcpServerInstance() {
  const server = new McpServer(serverInfo);
  const registerTool = server.registerTool.bind(server);

  server.registerTool = (name, toolConfig, handler) =>
    registerTool(name, toolConfig, wrapToolHandler(name, handler));

  registerServerTools(server);
  return server;
}

function registerServerTools(server) {
server.registerTool(
  "search_cities",
  agenticReadTool({
    description: "Search tripwiki city grounding cards for agent planning and destination discovery.",
    inputSchema: {
      query: z.string().min(1).describe("City, alias, or destination keyword to search."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of cities to return."),
    },
  }),
  async ({ query, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchCities(db, { query, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "search_destination_suggestions",
  agenticReadTool({
    description:
      "Resolve a freeform destination or hotel query through Bitvoya's live suggest index, with optional grounding excerpts.",
    inputSchema: {
      query: z.string().min(1).describe("Destination or hotel keyword."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum cities and hotels to return per section."),
    },
  }),
  async ({ query, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchDestinationSuggestions(api, db, { query, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "search_cities_live",
  agenticReadTool({
    description: "Search Bitvoya's live city index for destination input UX and city-id resolution.",
    inputSchema: {
      keyword: z.string().min(1).describe("City keyword."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of cities to return."),
    },
  }),
  async ({ keyword, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchCitiesLive(api, db, { keyword, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "list_hot_cities",
  agenticReadTool({
    description: "Return Bitvoya's hot-city list for discovery entry points.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of hot cities to return."),
    },
  }),
  async ({ limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await listHotCities(api, db, { limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_city_grounding",
  agenticReadTool({
    description: "Get a grounded destination card with structured city context and top POIs.",
    inputSchema: {
      source_city_id: z.string().optional().describe("Bitvoya / source city id."),
      tripwiki_city_id: z.string().optional().describe("Tripwiki canonical city id."),
      city_name: z.string().optional().describe("Fallback city name lookup."),
      poi_limit: z.number().int().min(1).max(20).optional().describe("Maximum nearby POIs to include."),
    },
  }),
  async ({ source_city_id, tripwiki_city_id, city_name, poi_limit }) => {
    if (!source_city_id && !tripwiki_city_id && !city_name) {
      throw new Error("One of source_city_id, tripwiki_city_id, or city_name is required.");
    }

    const resolvedPoiLimit = clampLimit(poi_limit, config.limits.defaultPoi, 20);
    const payload = await getCityGrounding(
      db,
      { source_city_id, tripwiki_city_id, city_name },
      resolvedPoiLimit
    );

    if (!payload) {
      return asTextResult(
        buildAgenticToolResult({
          tool: "get_city_grounding",
          status: "not_found",
          intent: "destination_grounding",
          summary: "No city grounding card matched the supplied identity.",
          recommended_next_tools: [
            buildNextTool("search_cities", "Search the grounding layer by a broader destination keyword.", [
              "query",
            ]),
            buildNextTool("search_cities_live", "Resolve a live Bitvoya city id from user-entered text.", [
              "keyword",
            ]),
          ],
          data: {
            found: false,
            reason: "No city grounding card matched the supplied identity.",
          },
        })
      );
    }

    return asTextResult(payload);
  }
);

server.registerTool(
  "search_hotels",
  agenticReadTool({
    description:
      "API-first live hotel discovery for Bitvoya inventory. Search by city or keyword and optionally attach search-stage supplier min prices.",
    inputSchema: {
      query: z.string().optional().describe("Hotel or destination keyword."),
      city_id: z.string().optional().describe("Known Bitvoya city id."),
      city_name: z.string().optional().describe("City name to resolve through Bitvoya suggest API."),
      checkin: z.string().optional().describe("Stay start date in YYYY-MM-DD."),
      checkout: z.string().optional().describe("Stay end date in YYYY-MM-DD."),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults for pricing lookup."),
      offset: z.number().int().min(0).max(200).optional().describe("Result offset for local pagination."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of hotels to return."),
      priority_profile: hotelComparisonPriorityProfileSchema
        .optional()
        .describe("How to rank the returned shortlist: balanced, price, perks, luxury, location, flexibility, or low_due_now."),
      payment_preference: paymentPreferenceSchema
        .optional()
        .describe("Optional preferred payment path to bias shortlist ranking."),
      require_free_cancellation: z.boolean().optional().describe("Bias shortlist logic toward flexible inventory; must still be validated on live rates."),
      prefer_benefits: z.boolean().optional().describe("Bias shortlist logic toward explicit member/perk payloads."),
    },
  }),
  async ({
    query,
    city_id,
    city_name,
    checkin,
    checkout,
    adult_num,
    offset,
    limit,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) => {
    if (!query && !city_id && !city_name) {
      throw new Error("One of query, city_id, or city_name is required.");
    }

    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const resolvedOffset = clampInteger(offset, 0, 0, 200);
    const payload = await searchHotels(api, db, {
      query,
      city_id,
      city_name,
      checkin,
      checkout,
      adult_num: adult_num || 2,
      offset: resolvedOffset,
      limit: resolvedLimit,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_detail",
  agenticReadTool({
    description:
      "Fetch Bitvoya hotel detail from the existing API and augment it with tripwiki grounding excerpts.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
    },
  }),
  async ({ hotel_id }) => {
    const payload = await getHotelDetail(api, db, { hotel_id });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_profile",
  agenticReadTool({
    description:
      "Fetch Bitvoya's rich static God Profile for a hotel and pair it with the normalized hotel detail payload.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
    },
  }),
  async ({ hotel_id }) => {
    const payload = await getHotelProfile(api, db, { hotel_id });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_rooms",
  agenticReadTool({
    description:
      "Fetch live room and rate inventory with explicit supplier total, service fee, display total, and payment-option semantics.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      checkin: z.string().min(1).describe("Stay start date in YYYY-MM-DD."),
      checkout: z.string().min(1).describe("Stay end date in YYYY-MM-DD."),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults."),
      child_num: z.number().int().min(0).max(6).optional().describe("Number of children."),
      room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms requested."),
      room_limit: z.number().int().min(1).max(20).optional().describe("Maximum room entries to return."),
      rate_limit_per_room:
        z.number().int().min(1).max(20).optional().describe("Maximum rates to keep per room."),
      priority_profile: rateComparisonPriorityProfileSchema
        .optional()
        .describe("Optional preference profile to produce a primary in-tool rate recommendation."),
      payment_preference: paymentPreferenceSchema
        .optional()
        .describe("Optional preferred payment path to bias the in-tool recommendation."),
      require_free_cancellation: z.boolean().optional().describe("Prefer free-cancel rates in the in-tool recommendation."),
      prefer_benefits: z.boolean().optional().describe("Bias the in-tool recommendation toward rates with explicit benefits."),
    },
  }),
  async ({
    hotel_id,
    checkin,
    checkout,
    adult_num,
    child_num,
    room_num,
    room_limit,
    rate_limit_per_room,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) => {
    const resolvedRoomLimit = clampLimit(
      room_limit,
      config.limits.defaultRoomLimit,
      config.limits.maxRoomLimit
    );
    const resolvedRateLimit = clampLimit(
      rate_limit_per_room,
      config.limits.defaultRateLimit,
      config.limits.maxRateLimit
    );

    const payload = await getHotelRooms(api, db, {
      hotel_id,
      checkin,
      checkout,
      adult_num: adult_num || 2,
      child_num: child_num || 0,
      room_num: room_num || 1,
      room_limit: resolvedRoomLimit,
      rate_limit_per_room: resolvedRateLimit,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "compare_hotels",
  agenticReadTool({
    description:
      "Compare multiple hotels with agent-oriented strengths, tradeoffs, benefit signals, and optional live stay-price snapshots.",
    inputSchema: {
      hotel_ids: z
        .array(z.string().min(1))
        .min(2)
        .max(5)
        .describe("Two to five Bitvoya hotel ids to compare."),
      checkin: z.string().optional().describe("Optional stay start date in YYYY-MM-DD for live rate snapshots."),
      checkout: z.string().optional().describe("Optional stay end date in YYYY-MM-DD for live rate snapshots."),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults for live stay comparison."),
      child_num: z.number().int().min(0).max(6).optional().describe("Number of children for live stay comparison."),
      room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms for live stay comparison."),
      priority_profile: hotelComparisonPriorityProfileSchema
        .optional()
        .describe("How to rank hotels: balanced, price, perks, luxury, location, flexibility, or low_due_now."),
      payment_preference: paymentPreferenceSchema
        .optional()
        .describe("Optional preferred payment path to bias the ranking."),
      require_free_cancellation: z.boolean().optional().describe("Prefer hotels with live free-cancel options when stay dates are supplied."),
      prefer_benefits: z.boolean().optional().describe("Bias ranking toward explicit member / perk payloads."),
    },
  }),
  async ({
    hotel_ids,
    checkin,
    checkout,
    adult_num,
    child_num,
    room_num,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) => {
    const payload = await compareHotels(api, db, {
      hotel_ids,
      checkin,
      checkout,
      adult_num: adult_num || 2,
      child_num: child_num || 0,
      room_num: room_num || 1,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "compare_rates",
  agenticReadTool({
    description:
      "Compare room/rate options inside one hotel and surface cheapest, most flexible, best-benefits, best-guarantee, and best-prepay picks.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      checkin: z.string().min(1).describe("Stay start date in YYYY-MM-DD."),
      checkout: z.string().min(1).describe("Stay end date in YYYY-MM-DD."),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults."),
      child_num: z.number().int().min(0).max(6).optional().describe("Number of children."),
      room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms requested."),
      room_id: z.string().optional().describe("Optional room_id filter."),
      rate_ids: z.array(z.string().min(1)).max(20).optional().describe("Optional subset of rate_ids to compare."),
      room_limit: z.number().int().min(1).max(20).optional().describe("Maximum room entries to fetch before flattening rates."),
      rate_limit_per_room: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum rates per room to fetch before comparison."),
      priority_profile: rateComparisonPriorityProfileSchema
        .optional()
        .describe("How to rank rates: balanced, price, perks, flexibility, or low_due_now."),
      payment_preference: paymentPreferenceSchema
        .optional()
        .describe("Optional preferred payment path to bias the ranking."),
      require_free_cancellation: z.boolean().optional().describe("Prefer free-cancel rates."),
      prefer_benefits: z.boolean().optional().describe("Bias ranking toward rates with explicit benefit payloads."),
    },
  }),
  async ({
    hotel_id,
    checkin,
    checkout,
    adult_num,
    child_num,
    room_num,
    room_id,
    rate_ids,
    room_limit,
    rate_limit_per_room,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) => {
    const payload = await compareRates(api, db, {
      hotel_id,
      checkin,
      checkout,
      adult_num: adult_num || 2,
      child_num: child_num || 0,
      room_num: room_num || 1,
      room_id,
      rate_ids,
      room_limit: room_limit || 10,
      rate_limit_per_room: rate_limit_per_room || 10,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "prepare_booking_quote",
  {
    description:
      "Re-fetch live room inventory and freeze a short-lived booking quote for a specific hotel / room / rate selection.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      room_id: z.string().min(1).describe("Selected room id."),
      rate_id: z.string().min(1).describe("Selected rate id from get_hotel_rooms."),
      checkin: z.string().min(1).describe("Stay start date in YYYY-MM-DD."),
      checkout: z.string().min(1).describe("Stay end date in YYYY-MM-DD."),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults."),
      child_num: z.number().int().min(0).max(6).optional().describe("Number of children."),
      room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms requested."),
    },
  },
  async ({ hotel_id, room_id, rate_id, checkin, checkout, adult_num, child_num, room_num }, extra) => {
    const payload = await prepareBookingQuote(api, db, store, config, {
      hotel_id,
      room_id,
      rate_id,
      checkin,
      checkout,
      adult_num: adult_num || 2,
      child_num: child_num || 0,
      room_num: room_num || 1,
    }, {
      execution_mode: bookingExecutionMode,
      config,
      request_principal: extra?.bitvoyaAuth?.principal || null,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "create_booking_intent",
  {
    description:
      "Create a server-owned booking intent from a valid quote, with guest/contact data and payment-path selection.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      quote_id: z.string().min(1).describe("Quote id from prepare_booking_quote."),
      payment_method: z.enum(["prepay", "guarantee"]).describe("Selected payment path."),
      guest_primary: z.object({
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        gender: z.string().optional(),
        frequent_traveler: z.string().optional(),
        membership_level: z.string().optional(),
      }),
      contact: z.object({
        email: z.string().min(1),
        phone: z.string().min(1),
        country_code: z.string().optional(),
        custom_country_code: z.string().optional(),
        full_phone: z.string().optional(),
      }),
      companions: z
        .array(
          z.object({
            first_name: z.string().min(1),
            last_name: z.string().min(1),
            gender: z.string().optional(),
          })
        )
        .optional(),
      children: z
        .array(
          z.object({
            age: z.number().int().min(0).max(17),
          })
        )
        .optional(),
      arrival_time: z.string().optional(),
      special_requests: z.array(z.string().min(1)).optional(),
      user_info: z.record(z.string(), z.unknown()).optional().describe("Optional user snapshot for later legacy-submit bridging."),
    },
  },
  async ({ quote_id, payment_method, guest_primary, contact, companions, children, arrival_time, special_requests, user_info }, extra) => {
    const payload = await createBookingIntent(store, {
      quote_id,
      payment_method,
      guest_primary,
      contact,
      companions,
      children,
      arrival_time,
      special_requests,
      user_info,
    }, {
      execution_mode: bookingExecutionMode,
      config,
      request_principal: extra?.bitvoyaAuth?.principal || null,
    });

    return asTextResult(payload);
  }
);

if (internalExecutionEnabled) {
  server.registerTool(
    "attach_booking_card",
    {
      description:
        "Attach a guarantee card reference or direct PAN+expiry payload to a booking intent. Intended only for trusted Bitvoya-controlled agent flows.",
      outputSchema: agenticToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        intent_id: z.string().min(1).describe("Booking intent id."),
        card_reference_id: z.string().optional().describe("Existing stored card reference."),
        pan: z.string().optional().describe("Card number. Use only in trusted private MCP mode."),
        expiry: z.string().optional().describe("Card expiry in MM/YY or MM/YYYY."),
        cardholder_name: z.string().optional().describe("Optional cardholder name."),
        card_type: z.string().optional().describe("Optional card type override."),
        card_brand: z.string().optional().describe("Optional card brand override."),
      },
    },
    async ({ intent_id, card_reference_id, pan, expiry, cardholder_name, card_type, card_brand }, extra) => {
      if (!card_reference_id && (!pan || !expiry)) {
        throw new Error("Either card_reference_id or pan + expiry is required.");
      }

      const payload = await attachBookingCard(store, config, {
        intent_id,
        card_reference_id,
        pan,
        expiry,
        cardholder_name,
        card_type,
        card_brand,
      }, {
        execution_mode: bookingExecutionMode,
        config,
        request_principal: extra?.bitvoyaAuth?.principal || null,
      });

      return asTextResult(payload);
    }
  );
}

server.registerTool(
  "get_booking_state",
  {
    description:
      "Inspect the current local state of a booking quote or booking intent, including bridged backend order and payment-session state when available.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      quote_id: z.string().optional().describe("Quote id."),
      intent_id: z.string().optional().describe("Intent id."),
    },
  },
  async ({ quote_id, intent_id }) => {
    if (!quote_id && !intent_id) {
      throw new Error("One of quote_id or intent_id is required.");
    }

    const payload = await getBookingState(store, {
      quote_id,
      intent_id,
    }, {
      execution_mode: bookingExecutionMode,
      config,
    });

    return asTextResult(payload);
  }
);

if (internalExecutionEnabled) {
  server.registerTool(
    "submit_booking_intent",
    {
      description:
        "Bridge a prepared booking intent into Bitvoya's existing /booking/submit flow without changing the legacy backend contract.",
      outputSchema: agenticToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        intent_id: z.string().min(1).describe("Booking intent id."),
      },
    },
    async ({ intent_id }) => {
      const payload = await submitBookingIntent(api, store, config, {
        intent_id,
      }, {
        execution_mode: bookingExecutionMode,
        config,
      });

      return asTextResult(payload);
    }
  );

  server.registerTool(
    "create_booking_payment_session",
    {
      description:
        "Create a Stripe payment session for a submitted booking intent when the booking flow requires immediate payment.",
      outputSchema: agenticToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        intent_id: z.string().min(1).describe("Booking intent id."),
        success_url: z.string().optional().describe("Optional absolute success redirect URL override."),
        cancel_url: z.string().optional().describe("Optional absolute cancel redirect URL override."),
      },
    },
    async ({ intent_id, success_url, cancel_url }) => {
      const payload = await createBookingPaymentSession(api, store, {
        intent_id,
        success_url,
        cancel_url,
      }, {
        execution_mode: bookingExecutionMode,
        config,
      });

      return asTextResult(payload);
    }
  );

  server.registerTool(
    "refresh_booking_state",
    {
      description:
        "Refresh a submitted booking intent from Bitvoya's live order-detail endpoint to sync backend booking and payment status.",
      outputSchema: agenticToolOutputSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        intent_id: z.string().min(1).describe("Booking intent id."),
      },
    },
    async ({ intent_id }) => {
      const payload = await refreshBookingState(api, store, {
        intent_id,
      }, {
        execution_mode: bookingExecutionMode,
        config,
      });

      return asTextResult(payload);
    }
  );
}

server.registerTool(
  "get_hotel_media",
  agenticReadTool({
    description: "Fetch hotel media assets for gallery, briefing, and visual grounding use cases.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of media items to return."),
    },
  }),
  async ({ hotel_id, limit }) => {
    const resolvedLimit = clampInteger(limit, 12, 1, 50);
    const payload = await getHotelMedia(api, { hotel_id, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_nearby_hotels",
  agenticReadTool({
    description: "Fetch nearby hotels from the Bitvoya API for competitive set and area comparison.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      lang: z.string().optional().describe("Language code, for example en or zh_cn."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum nearby hotels to return."),
      radius_km: z.number().min(0.5).max(50).optional().describe("Search radius in kilometers."),
    },
  }),
  async ({ hotel_id, lang, limit, radius_km }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await getNearbyHotels(api, db, {
      hotel_id,
      lang: lang || "en",
      limit: resolvedLimit,
      radius_km: radius_km || 5,
    });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_collections",
  agenticReadTool({
    description: "Return the SEO / editorial collections that a hotel belongs to.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      lang: z.string().optional().describe("Language code, for example en or zh_cn."),
    },
  }),
  async ({ hotel_id, lang }) => {
    const payload = await getHotelCollections(api, { hotel_id, lang: lang || "en" });
    return asTextResult(payload);
  }
);

server.registerTool(
  "list_seo_collections",
  agenticReadTool({
    description: "List available editorial SEO collections for discovery, routing, and content planning.",
    inputSchema: {
      lang: z.string().optional().describe("Language code, for example en or zh_cn."),
      offset: z.number().int().min(0).max(5000).optional().describe("Result offset."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of collection rows to return."),
    },
  }),
  async ({ lang, offset, limit }) => {
    const resolvedOffset = clampInteger(offset, 0, 0, 5000);
    const resolvedLimit = clampInteger(limit, 10, 1, 50);
    const payload = await listSeoCollections(api, {
      lang: lang || "en",
      offset: resolvedOffset,
      limit: resolvedLimit,
    });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_seo_collection",
  agenticReadTool({
    description: "Fetch an editorial collection page and its hotel list for a city/tag pair.",
    inputSchema: {
      city: z.string().min(1).describe("Collection city name, for example Rome."),
      tag: z.string().min(1).describe("Collection tag, for example urban_oasis_gardens."),
      lang: z.string().optional().describe("Language code, for example en or zh_cn."),
      hotel_limit: z.number().int().min(1).max(50).optional().describe("Maximum number of hotels to keep from the collection."),
    },
  }),
  async ({ city, tag, lang, hotel_limit }) => {
    const resolvedLimit = clampInteger(hotel_limit, 12, 1, 50);
    const payload = await getSeoCollection(api, db, {
      city,
      tag,
      lang: lang || "en",
      hotel_limit: resolvedLimit,
    });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_featured_hotels",
  agenticReadTool({
    description: "Return Bitvoya's featured-hotel feed for discovery and merchandising use cases.",
    inputSchema: {
      domestic: z.number().int().min(1).max(3).optional().describe("Featured segment selector used by the current API."),
      page: z.number().int().min(1).max(20).optional().describe("Page number."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of featured hotels to return."),
    },
  }),
  async ({ domestic, page, limit }) => {
    const payload = await getFeaturedHotels(api, {
      domestic: domestic || 2,
      page: page || 1,
      limit: clampInteger(limit, 6, 1, 20),
    });
    return asTextResult(payload);
  }
);

server.registerTool(
  "search_hotels_grounding",
  agenticReadTool({
    description: "Search tripwiki hotel grounding cards without hitting live product inventory.",
    inputSchema: {
      query: z.string().min(1).describe("Hotel name, brand, or destination keyword."),
      city_name: z.string().optional().describe("Optional city filter."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of hotels to return."),
    },
  }),
  async ({ query, city_name, limit }) => {
    const resolvedLimit = clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch);
    const payload = await searchHotelsGrounding(db, { query, city_name, limit: resolvedLimit });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_grounding",
  agenticReadTool({
    description: "Get a grounded Bitvoya hotel card with transport, traveler fit, and nearby POIs.",
    inputSchema: {
      source_hotel_id: z.string().optional().describe("Bitvoya / source hotel id."),
      tripwiki_hotel_id: z.string().optional().describe("Tripwiki canonical hotel id."),
      hotel_name: z.string().optional().describe("Fallback hotel name lookup."),
      poi_limit: z.number().int().min(1).max(20).optional().describe("Maximum nearby POIs to include."),
    },
  }),
  async ({ source_hotel_id, tripwiki_hotel_id, hotel_name, poi_limit }) => {
    if (!source_hotel_id && !tripwiki_hotel_id && !hotel_name) {
      throw new Error("One of source_hotel_id, tripwiki_hotel_id, or hotel_name is required.");
    }

    const resolvedPoiLimit = clampLimit(poi_limit, config.limits.defaultPoi, 20);
    const payload = await getHotelGrounding(
      db,
      { source_hotel_id, tripwiki_hotel_id, hotel_name },
      resolvedPoiLimit
    );

    if (!payload) {
      return asTextResult(
        buildAgenticToolResult({
          tool: "get_hotel_grounding",
          status: "not_found",
          intent: "hotel_grounding",
          summary: "No hotel grounding card matched the supplied identity.",
          recommended_next_tools: [
            buildNextTool("search_hotels_grounding", "Search the grounding layer by hotel or brand keyword.", [
              "query",
            ]),
            buildNextTool("search_destination_suggestions", "Fallback to live destination and hotel suggestions.", [
              "query",
            ]),
          ],
          data: {
            found: false,
            reason: "No hotel grounding card matched the supplied identity.",
          },
        })
      );
    }

    return asTextResult(payload);
  }
);

}

const server = createMcpServerInstance();

async function main() {
  const dbStatus = await db.ping();
  const authDbStatus = await authDb.ping();
  console.error("bitvoya-mcp starting");
  console.error(
    JSON.stringify(
      {
        config: summarizeConfig(config),
        authProfile,
        bookingExecution: {
          mode: bookingExecutionMode,
          internalExecutionToolsExposed: internalExecutionEnabled,
        },
        dbStatus,
        authDbStatus,
        store: {
          path: store.getStorePath(),
          counts: store.getSnapshotCounts(),
        },
      },
      null,
      2
    )
  );

  if (config.server.transport === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (config.server.transport === "streamable_http") {
    remoteServer = await startRemoteServer({
      config,
      authDb,
      buildServer: createMcpServerInstance,
    });
    console.error(
      `bitvoya-mcp remote gateway listening on http://${config.http.host}:${config.http.port}${config.http.path}`
    );
    return;
  }

  throw new Error(`Unsupported BITVOYA_MCP_TRANSPORT '${config.server.transport}'.`);
}

async function shutdown() {
  if (remoteServer) {
    await remoteServer.close();
    remoteServer = null;
  }

  await server.close();
  await db.close();
  await authDb.close();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

main().catch(async (error) => {
  console.error("Server error:", error);
  await shutdown();
  process.exit(1);
});
