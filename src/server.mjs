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
const serverLocalTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const serverLocalDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: serverLocalTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const relativeDateInstruction =
  `When the user says relative dates like today, tomorrow, or the day after tomorrow, resolve them against the MCP server-local calendar date ${serverLocalDate} (${serverLocalTimeZone}) and pass concrete YYYY-MM-DD dates instead of asking for clarification by default.`;
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
const paymentMethodSchema = z.enum(["prepay", "guarantee"]);
const guestPrimaryInputSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  gender: z.string().optional(),
  frequent_traveler: z.string().optional(),
  membership_level: z.string().optional(),
});
const contactInputSchema = z.object({
  email: z.string().min(1),
  phone: z.string().min(1),
  country_code: z.string().optional(),
  custom_country_code: z.string().optional(),
  full_phone: z.string().optional(),
});
const companionsInputSchema = z
  .array(
    z.object({
      first_name: z.string().min(1),
      last_name: z.string().min(1),
      gender: z.string().optional(),
    })
  )
  .optional();
const childrenInputSchema = z
  .array(
    z.object({
      age: z.number().int().min(0).max(17),
    })
  )
  .optional();
const userInfoInputSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Optional user snapshot for later legacy-submit bridging. You may also pass user_info.preferred_language or user_info.lang so Bitvoya secure checkout follows the traveler language. Supported display languages are English, Chinese, Japanese, and Korean; other languages fall back to English."
  );

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
async function runHotelSearchTool(params) {
  const {
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
  } = params;

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

function normalizeEntryQueryText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function containsAnyRouteHint(text, hints) {
  return hints.some((hint) => text.includes(hint));
}

function inferEntryIntent({ query, checkin, checkout, intent_hint }) {
  const normalizedHint = String(intent_hint || "auto").trim();
  if (normalizedHint && normalizedHint !== "auto") {
    return normalizedHint;
  }

  const text = normalizeEntryQueryText(query);
  if (!text) {
    return "hotel_search";
  }

  const dateLikeHints = [
    "today",
    "tomorrow",
    "tonight",
    "this weekend",
    "next weekend",
    "next week",
    "today's",
    "今天",
    "明天",
    "今晚",
    "周末",
    "下周",
  ];
  const hotelSearchHints = [
    "hotel",
    "hotels",
    "resort",
    "room",
    "rooms",
    "rate",
    "rates",
    "price",
    "pricing",
    "availability",
    "available",
    "book",
    "booking",
    "stay",
    "compare hotels",
    "酒店",
    "房型",
    "房价",
    "价格",
    "可订",
    "预订",
    "入住",
    "离店",
    "比价",
  ];
  const destinationGroundingHints = [
    "where to stay",
    "best area",
    "best areas",
    "best neighborhood",
    "best neighbourhood",
    "district",
    "districts",
    "neighborhood",
    "neighbourhood",
    "area",
    "areas",
    "walkable",
    "walkability",
    "transport",
    "landmark",
    "landmarks",
    "safety",
    "itinerary",
    "guide",
    "vibe",
    "vibes",
    "grounding",
    "哪里住",
    "住哪里",
    "区域",
    "片区",
    "街区",
    "地段",
    "交通",
    "景点",
    "周边",
    "攻略",
    "氛围",
    "适合住",
    "适合家庭",
    "适合情侣",
  ];
  const hotelGroundingHints = [
    "this hotel",
    "that hotel",
    "the hotel",
    "this property",
    "that property",
    "worth it",
    "hotel fit",
    "why stay",
    "property fit",
    "酒店怎么样",
    "这家酒店",
    "这个酒店",
    "值不值得",
    "适合谁",
    "位置如何",
  ];

  if (checkin || checkout || containsAnyRouteHint(text, dateLikeHints)) {
    return "hotel_search";
  }

  const wantsHotelSearch = containsAnyRouteHint(text, hotelSearchHints);
  const wantsDestinationGrounding = containsAnyRouteHint(text, destinationGroundingHints);
  const wantsHotelGrounding = containsAnyRouteHint(text, hotelGroundingHints);

  if (wantsDestinationGrounding && !wantsHotelSearch) {
    return "destination_grounding";
  }

  if (wantsHotelGrounding && !wantsHotelSearch) {
    return "hotel_grounding";
  }

  return "auto";
}

function inferEntryIntentFromSuggestions(initialIntent, suggestionPayload, options = {}) {
  if (initialIntent !== "auto") {
    return initialIntent;
  }

  if (options.checkin || options.checkout) {
    return "hotel_search";
  }

  const cityCount = Number(suggestionPayload?.data?.count?.cities || 0);
  const hotelCount = Number(suggestionPayload?.data?.count?.hotels || 0);

  if (cityCount > 0 && hotelCount === 0) {
    return "destination_grounding";
  }

  if (hotelCount > 0 && cityCount === 0) {
    return "hotel_grounding";
  }

  return "hotel_search";
}

function withEntryRouting(payload, entryTool, routedTool, reason) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const existingDecisionSupport =
    payload.decision_support && typeof payload.decision_support === "object"
      ? payload.decision_support
      : {};
  const selectionHints = Array.isArray(existingDecisionSupport.selection_hints)
    ? existingDecisionSupport.selection_hints
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];

  const routingHint = `Entry router ${entryTool} selected ${routedTool} because ${reason}.`;
  if (!selectionHints.includes(routingHint)) {
    selectionHints.unshift(routingHint);
  }

  return {
    ...payload,
    decision_support: {
      ...existingDecisionSupport,
      selection_hints: selectionHints,
    },
    data:
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? {
            entry_routing: {
              entry_tool: entryTool,
              routed_tool: routedTool,
              reason,
            },
            ...payload.data,
          }
        : {
            entry_routing: {
              entry_tool: entryTool,
              routed_tool: routedTool,
              reason,
            },
            routed_payload: payload.data ?? null,
          },
  };
}

function pickPresent(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "string" && !value.trim()) {
      continue;
    }

    return value;
  }

  return undefined;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value).trim();
  return text ? text : undefined;
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}

function normalizeStringList(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized = items.map((item) => String(item || "").trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGuestPrimaryInput(source = {}, fallbacks = {}) {
  const primary = asPlainObject(source);
  const fallback = asPlainObject(fallbacks);

  return {
    first_name: normalizeOptionalText(
      pickPresent(
        primary.first_name,
        primary.firstName,
        fallback.first_name,
        fallback.firstName,
        fallback.first_name,
        fallback.firstName
      )
    ),
    last_name: normalizeOptionalText(
      pickPresent(
        primary.last_name,
        primary.lastName,
        fallback.last_name,
        fallback.lastName
      )
    ),
    gender: normalizeOptionalText(pickPresent(primary.gender, fallback.gender)),
    frequent_traveler: normalizeOptionalText(
      pickPresent(primary.frequent_traveler, primary.frequentTraveler, fallback.frequent_traveler, fallback.frequentTraveler)
    ),
    membership_level: normalizeOptionalText(
      pickPresent(primary.membership_level, primary.membershipLevel, fallback.membership_level, fallback.membershipLevel)
    ),
  };
}

function normalizeContactInput(source = {}, fallbacks = {}) {
  const contact = asPlainObject(source);
  const fallback = asPlainObject(fallbacks);

  return {
    email: normalizeOptionalText(pickPresent(contact.email, fallback.email)),
    phone: normalizeOptionalText(
      pickPresent(contact.phone, contact.phoneNumber, contact.mobile, fallback.phone, fallback.phoneNumber, fallback.mobile)
    ),
    country_code: normalizeOptionalText(
      pickPresent(contact.country_code, contact.countryCode, fallback.country_code, fallback.countryCode)
    ),
    custom_country_code: normalizeOptionalText(
      pickPresent(contact.custom_country_code, contact.customCountryCode, fallback.custom_country_code, fallback.customCountryCode)
    ),
    full_phone: normalizeOptionalText(
      pickPresent(contact.full_phone, contact.fullPhone, fallback.full_phone, fallback.fullPhone)
    ),
  };
}

function normalizeCompanionList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => {
    const companion = asPlainObject(item);
    return {
      first_name: normalizeOptionalText(pickPresent(companion.first_name, companion.firstName)),
      last_name: normalizeOptionalText(pickPresent(companion.last_name, companion.lastName)),
      gender: normalizeOptionalText(companion.gender),
    };
  });
}

function normalizeChildrenList(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.map((item) => {
    const child = asPlainObject(item);
    return {
      age: normalizeOptionalNumber(pickPresent(child.age, child.child_age, child.childAge)),
    };
  });
}

function normalizeHotelRoomLookupArgs(input = {}) {
  const params = asPlainObject(input);

  return {
    hotel_id: normalizeOptionalText(pickPresent(params.hotel_id, params.hotelId)),
    hotel_name: normalizeOptionalText(pickPresent(params.hotel_name, params.hotelName)),
    city_name: normalizeOptionalText(pickPresent(params.city_name, params.cityName)),
    checkin: normalizeOptionalText(params.checkin),
    checkout: normalizeOptionalText(params.checkout),
    adult_num: normalizeOptionalNumber(pickPresent(params.adult_num, params.adultNum)),
    child_num: normalizeOptionalNumber(pickPresent(params.child_num, params.childNum)),
    room_num: normalizeOptionalNumber(pickPresent(params.room_num, params.roomNum)),
    room_limit: normalizeOptionalNumber(pickPresent(params.room_limit, params.roomLimit)),
    rate_limit_per_room: normalizeOptionalNumber(
      pickPresent(params.rate_limit_per_room, params.rateLimitPerRoom)
    ),
    priority_profile: normalizeOptionalText(
      pickPresent(params.priority_profile, params.priorityProfile)
    ),
    payment_preference: normalizeOptionalText(
      pickPresent(params.payment_preference, params.paymentPreference)
    ),
    require_free_cancellation: normalizeOptionalBoolean(
      pickPresent(params.require_free_cancellation, params.requireFreeCancellation)
    ),
    prefer_benefits: normalizeOptionalBoolean(
      pickPresent(params.prefer_benefits, params.preferBenefits)
    ),
  };
}

function normalizePrepareBookingQuoteArgs(input = {}) {
  const params = asPlainObject(input);
  const normalized = normalizeHotelRoomLookupArgs(params);

  return {
    ...normalized,
    room_id: normalizeOptionalText(pickPresent(params.room_id, params.roomId)),
    rate_id: normalizeOptionalText(pickPresent(params.rate_id, params.rateId)),
  };
}

function normalizeCreateBookingIntentArgs(input = {}) {
  const params = asPlainObject(input);
  const bookingQuote = asPlainObject(pickPresent(params.booking_quote, params.bookingQuote));
  const contactSource = asPlainObject(pickPresent(params.contact, params.contactInfo));
  const fallbackContactSource = {
    email: params.email,
    phone: pickPresent(params.phone, params.phoneNumber, params.mobile),
    country_code: pickPresent(params.country_code, params.countryCode),
    custom_country_code: pickPresent(params.custom_country_code, params.customCountryCode),
    full_phone: pickPresent(params.full_phone, params.fullPhone),
    first_name: pickPresent(params.first_name, params.firstName),
    last_name: pickPresent(params.last_name, params.lastName),
  };
  const guestPrimarySource = asPlainObject(
    pickPresent(params.guest_primary, params.guestPrimary, params.guest)
  );

  return {
    prepared_quote_id: normalizeOptionalText(
      pickPresent(
        params.prepared_quote_id,
        params.preparedQuoteId,
        bookingQuote.prepared_quote_id,
        bookingQuote.preparedQuoteId
      )
    ),
    quote_id: normalizeOptionalText(
      pickPresent(params.quote_id, params.quoteId, bookingQuote.quote_id, bookingQuote.quoteId)
    ),
    payment_method: normalizeOptionalText(
      pickPresent(
        params.payment_method,
        params.paymentMethod,
        params.payment_path,
        params.paymentPath
      )
    )?.toLowerCase(),
    guest_primary: normalizeGuestPrimaryInput(guestPrimarySource, {
      ...contactSource,
      ...fallbackContactSource,
    }),
    contact: normalizeContactInput(contactSource, fallbackContactSource),
    companions: normalizeCompanionList(params.companions),
    children: normalizeChildrenList(params.children),
    arrival_time: normalizeOptionalText(pickPresent(params.arrival_time, params.arrivalTime)),
    special_requests: normalizeStringList(
      pickPresent(params.special_requests, params.specialRequests)
    ),
    user_info: asPlainObject(pickPresent(params.user_info, params.userInfo)),
  };
}

function normalizeCreateBookingArgs(input = {}) {
  const params = asPlainObject(input);
  const bookingQuote = asPlainObject(pickPresent(params.booking_quote, params.bookingQuote));

  return {
    ...normalizePrepareBookingQuoteArgs({
      ...params,
      room_id: pickPresent(params.room_id, params.roomId, bookingQuote.room_id, bookingQuote.roomId),
      rate_id: pickPresent(params.rate_id, params.rateId, bookingQuote.rate_id, bookingQuote.rateId),
    }),
    ...normalizeCreateBookingIntentArgs({
      ...params,
      quote_id: pickPresent(params.quote_id, params.quoteId, bookingQuote.quote_id, bookingQuote.quoteId),
      prepared_quote_id: pickPresent(
        params.prepared_quote_id,
        params.preparedQuoteId,
        bookingQuote.prepared_quote_id,
        bookingQuote.preparedQuoteId
      ),
    }),
  };
}

function normalizeBookingStateArgs(input = {}) {
  const params = asPlainObject(input);

  return {
    prepared_quote_id: normalizeOptionalText(
      pickPresent(params.prepared_quote_id, params.preparedQuoteId)
    ),
    quote_id: normalizeOptionalText(pickPresent(params.quote_id, params.quoteId)),
    intent_id: normalizeOptionalText(pickPresent(params.intent_id, params.intentId)),
  };
}

function rewriteToolResult(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const decisionSupport =
    payload.decision_support && typeof payload.decision_support === "object"
      ? payload.decision_support
      : {};
  const selectionHints = Array.isArray(decisionSupport.selection_hints)
    ? decisionSupport.selection_hints.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const addedHint = normalizeOptionalText(options.selection_hint);

  if (addedHint && !selectionHints.includes(addedHint)) {
    selectionHints.unshift(addedHint);
  }

  const dataPatch =
    options.data_patch && typeof options.data_patch === "object" && !Array.isArray(options.data_patch)
      ? options.data_patch
      : null;
  const existingData =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : null;

  return {
    ...payload,
    ...(options.tool ? { tool: options.tool } : {}),
    ...(options.summary_prefix
      ? { summary: `${options.summary_prefix}${payload.summary ? ` ${payload.summary}` : ""}`.trim() }
      : {}),
    decision_support: {
      ...decisionSupport,
      ...(selectionHints.length > 0 ? { selection_hints: selectionHints } : {}),
    },
    ...(dataPatch || existingData
      ? {
          data: {
            ...(existingData || {}),
            ...(dataPatch || {}),
          },
        }
      : {}),
  };
}

async function runTravelPlanningEntryTool(params) {
  const {
    query,
    checkin,
    checkout,
    adult_num,
    limit,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
    intent_hint,
  } = params;

  if (!query) {
    throw new Error("query is required.");
  }

  const initialIntent = inferEntryIntent({ query, checkin, checkout, intent_hint });
  const suggestionPayload =
    initialIntent === "hotel_search" && (checkin || checkout)
      ? null
      : await searchDestinationSuggestions(api, db, {
          query,
          limit: clampInteger(limit, 5, 1, 10),
        });
  const resolvedIntent = inferEntryIntentFromSuggestions(initialIntent, suggestionPayload, {
    checkin,
    checkout,
  });

  if (resolvedIntent === "destination_grounding") {
    const topCity =
      suggestionPayload?.data?.cities?.find((item) => item?.city_id || item?.city_name) || null;

    if (topCity) {
      const payload = await getCityGrounding(
        db,
        {
          source_city_id: topCity.city_id || undefined,
          city_name: topCity.city_name || query,
        },
        clampInteger(limit, config.limits.defaultPoi, 1, 20)
      );

      if (payload) {
        return asTextResult(
          withEntryRouting(
            payload,
            "start_travel_planning",
            "get_city_grounding",
            "the query looks destination-first and live suggestions resolved a city candidate"
          )
        );
      }
    }

    const payload = await searchCities(db, {
      query,
      limit: clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch),
    });
    return asTextResult(
      withEntryRouting(
        payload,
        "start_travel_planning",
        "search_cities",
        "the query looks destination-first, so grounding search is a safer entry path than hotel inventory"
      )
    );
  }

  if (resolvedIntent === "hotel_grounding") {
    const topHotel =
      suggestionPayload?.data?.hotels?.find((item) => item?.hotel_id || item?.hotel_name) || null;

    if (topHotel) {
      const payload = await getHotelGrounding(
        db,
        {
          source_hotel_id: topHotel.hotel_id || undefined,
          hotel_name: topHotel.hotel_name || query,
        },
        clampInteger(limit, config.limits.defaultPoi, 1, 20)
      );

      if (payload) {
        return asTextResult(
          withEntryRouting(
            payload,
            "start_travel_planning",
            "get_hotel_grounding",
            "the query looks hotel-specific without a booking step, so hotel grounding is a better first move than room search"
          )
        );
      }
    }

    const payload = await searchHotelsGrounding(db, {
      query,
      limit: clampLimit(limit, config.limits.defaultSearch, config.limits.maxSearch),
    });
    return asTextResult(
      withEntryRouting(
        payload,
        "start_travel_planning",
        "search_hotels_grounding",
        "the query appears hotel-specific but identity is still fuzzy, so grounding search is safer than live inventory"
      )
    );
  }

  return runHotelSearchTool({
    query,
    checkin,
    checkout,
    adult_num,
    limit,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  });
}

server.registerTool(
  "start_travel_planning",
  agenticReadTool({
    description:
      `Primary generic first-step tool for ambiguous user prompts across destination grounding, hotel grounding, and live hotel search. Use this when the user's first request is broad or unclear and you need Bitvoya to choose the right entry path before deeper tool calls. ${relativeDateInstruction}`,
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("Freeform user request or condensed travel intent. This may describe a destination, a hotel, or a broader where-to-stay question."),
      intent_hint: z
        .enum(["auto", "destination_grounding", "hotel_grounding", "hotel_search"])
        .optional()
        .describe("Optional routing hint. Leave as auto unless the user's request clearly belongs to one path."),
      checkin: z.string().optional().describe(`Optional stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
      checkout: z.string().optional().describe(`Optional stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults for hotel-search pricing when live inventory is the likely route."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum number of returned candidates or grounding rows."),
      priority_profile: hotelComparisonPriorityProfileSchema
        .optional()
        .describe("How to rank hotel shortlists when live inventory search is selected."),
      payment_preference: paymentPreferenceSchema
        .optional()
        .describe("Optional preferred payment path to bias shortlist ranking when live inventory search is selected."),
      require_free_cancellation: z.boolean().optional().describe("Bias live shortlist logic toward flexible inventory when hotel search is selected."),
      prefer_benefits: z.boolean().optional().describe("Bias live shortlist logic toward explicit member/perk payloads when hotel search is selected."),
    },
  }),
  async ({
    query,
    intent_hint,
    checkin,
    checkout,
    adult_num,
    limit,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) =>
    runTravelPlanningEntryTool({
      query,
      intent_hint,
      checkin,
      checkout,
      adult_num,
      limit,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    })
);

server.registerTool(
  "start_hotel_search",
  agenticReadTool({
    description:
      `Hotel-search-specific first-step tool for requests that already clearly want live hotel inventory, shortlist comparison, or rate discovery. If the user is still asking a broader where-to-stay or grounding question, prefer start_travel_planning instead. ${relativeDateInstruction}`,
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe("Concise destination, hotel, brand, district, or travel keyword extracted from the user's request."),
      checkin: z.string().optional().describe(`Optional stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
      checkout: z.string().optional().describe(`Optional stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
      adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults for pricing lookup."),
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
    checkin,
    checkout,
    adult_num,
    limit,
    priority_profile,
    payment_preference,
    require_free_cancellation,
    prefer_benefits,
  }) =>
    runHotelSearchTool({
      query,
      checkin,
      checkout,
      adult_num,
      limit,
      priority_profile,
      payment_preference,
      require_free_cancellation,
      prefer_benefits,
    })
);

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
      "Fallback resolver for ambiguous destination or hotel wording through Bitvoya's live suggest index, with optional grounding excerpts. Do not use this as the main hotel discovery tool when start_hotel_search or search_hotels fits the request.",
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
    description: "Use only for live city-id resolution and destination autocomplete. Not a general hotel discovery tool.",
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
      `Advanced live hotel discovery for Bitvoya inventory with direct city and pagination control. For most generic user hotel requests, prefer start_hotel_search first; use this tool when you already know the city, want direct city_id or city_name control, or are continuing an existing hotel-search workflow. ${relativeDateInstruction}`,
    inputSchema: {
      query: z.string().optional().describe("Hotel or destination keyword."),
      city_id: z.string().optional().describe("Known Bitvoya city id."),
      city_name: z.string().optional().describe("City name to resolve through Bitvoya suggest API."),
      checkin: z.string().optional().describe(`Stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
      checkout: z.string().optional().describe(`Stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
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
  }) =>
    runHotelSearchTool({
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
    })
);

server.registerTool(
  "get_hotel_detail",
  agenticReadTool({
    description:
      "Fetch live Bitvoya hotel detail plus grounding excerpts after a hotel candidate has already been selected. If hotel_id may come from a frontend page or foreign system, also pass hotel_name and optional city_name so MCP can recover the canonical live-inventory hotel id.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Canonical Bitvoya hotel id when known. May be a non-canonical external id when recovery hints are also provided."),
      hotel_name: z.string().min(1).optional().describe("Optional hotel name hint for canonical hotel-id recovery when hotel_id may be non-canonical."),
      city_name: z.string().min(1).optional().describe("Optional city hint to disambiguate hotel-name recovery."),
    },
  }),
  async ({ hotel_id, hotel_name, city_name }) => {
    const payload = await getHotelDetail(api, db, { hotel_id, hotel_name, city_name });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_profile",
  agenticReadTool({
    description:
      "Fetch Bitvoya's rich static God Profile for a hotel after a specific hotel candidate is already in focus. This is not a primary discovery tool. If hotel_id may be non-canonical, also pass hotel_name and optional city_name for recovery.",
    inputSchema: {
      hotel_id: z.string().min(1).describe("Canonical Bitvoya hotel id when known. May be a non-canonical external id when recovery hints are also provided."),
      hotel_name: z.string().min(1).optional().describe("Optional hotel name hint for canonical hotel-id recovery."),
      city_name: z.string().min(1).optional().describe("Optional city hint to disambiguate hotel-name recovery."),
    },
  }),
  async ({ hotel_id, hotel_name, city_name }) => {
    const payload = await getHotelProfile(api, db, { hotel_id, hotel_name, city_name });
    return asTextResult(payload);
  }
);

server.registerTool(
  "get_hotel_rooms",
  agenticReadTool({
    description:
      `Primary next-step tool after a hotel has been chosen. Fetch live room and rate inventory with explicit supplier total, service fee, display total, and payment-option semantics. Do not use before a specific hotel candidate is selected. If hotel_id may come from a frontend page or foreign system, also pass hotel_name and optional city_name so MCP can recover the canonical live-inventory hotel id. ${relativeDateInstruction}`,
    inputSchema: z.preprocess(
      (input) => normalizeHotelRoomLookupArgs(input),
      z.object({
        hotel_id: z.string().min(1).describe("Canonical Bitvoya hotel id when known. May be a non-canonical external id when recovery hints are also provided."),
        hotel_name: z.string().min(1).optional().describe("Optional hotel name hint for canonical hotel-id recovery when hotel_id may be non-canonical."),
        city_name: z.string().min(1).optional().describe("Optional city hint to disambiguate hotel-name recovery."),
        checkin: z.string().min(1).describe(`Stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
        checkout: z.string().min(1).describe(`Stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
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
      })
    ),
  }),
  async ({
    hotel_id,
    hotel_name,
    city_name,
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
  }, extra) => {
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
      hotel_name,
      city_name,
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
    }, {
      request_principal: extra?.bitvoyaAuth?.principal || null,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "compare_hotels",
  agenticReadTool({
    description:
      `Compare multiple already-selected hotels with agent-oriented strengths, tradeoffs, benefit signals, and optional live stay-price snapshots. Use this after start_hotel_search or search_hotels has produced hotel_ids. ${relativeDateInstruction}`,
    inputSchema: {
      hotel_ids: z
        .array(z.string().min(1))
        .min(2)
        .max(5)
        .describe("Two to five Bitvoya hotel ids to compare."),
      checkin: z.string().optional().describe(`Optional stay start date in YYYY-MM-DD for live rate snapshots. ${relativeDateInstruction}`),
      checkout: z.string().optional().describe(`Optional stay end date in YYYY-MM-DD for live rate snapshots. ${relativeDateInstruction}`),
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
  }, extra) => {
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
    }, {
      request_principal: extra?.bitvoyaAuth?.principal || null,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "compare_rates",
  agenticReadTool({
    description:
      `Compare room/rate options inside one already-selected hotel and surface cheapest, most flexible, best-benefits, best-guarantee, and best-prepay picks. Use this after get_hotel_rooms or when exact hotel and stay context is already fixed. ${relativeDateInstruction}`,
    inputSchema: {
      hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
      checkin: z.string().min(1).describe(`Stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
      checkout: z.string().min(1).describe(`Stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
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
  }, extra) => {
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
    }, {
      request_principal: extra?.bitvoyaAuth?.principal || null,
    });

    return asTextResult(payload);
  }
);

server.registerTool(
  "create_booking",
  {
    description:
      "High-level public booking starter. Prefer this over prepare_booking_quote plus create_booking_intent when you already know the selected hotel_id, room_id, rate_id, stay dates, guest, and contact. It will mint a fresh quote when needed, create the booking intent, and return Bitvoya secure handoff state without collecting sensitive card data inside chat.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    inputSchema: z.preprocess(
      (input) => normalizeCreateBookingArgs(input),
      z
        .object({
          prepared_quote_id: z
            .string()
            .min(1)
            .optional()
            .describe("Optional fresh prepared quote id from prepare_booking_quote. If absent or stale, create_booking can mint a new quote when full hotel_id + room_id + rate_id + stay context is supplied."),
          quote_id: z
            .string()
            .min(1)
            .optional()
            .describe("Deprecated alias for prepared_quote_id."),
          hotel_id: z.string().min(1).optional().describe("Bitvoya hotel id for automatic quote refresh when needed."),
          hotel_name: z.string().min(1).optional().describe("Optional hotel name hint for canonical hotel-id recovery during automatic quote refresh."),
          city_name: z.string().min(1).optional().describe("Optional city hint paired with hotel_name for identity recovery."),
          room_id: z.string().min(1).optional().describe("Selected room id for automatic quote refresh when needed."),
          rate_id: z.string().min(1).optional().describe("Selected rate id for automatic quote refresh when needed."),
          checkin: z.string().min(1).optional().describe(`Stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
          checkout: z.string().min(1).optional().describe(`Stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
          adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults."),
          child_num: z.number().int().min(0).max(6).optional().describe("Number of children."),
          room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms requested."),
          payment_method: paymentMethodSchema.describe("Selected payment path."),
          guest_primary: guestPrimaryInputSchema,
          contact: contactInputSchema,
          companions: companionsInputSchema,
          children: childrenInputSchema,
          arrival_time: z.string().optional(),
          special_requests: z.array(z.string().min(1)).optional(),
          user_info: userInfoInputSchema,
        })
        .superRefine((value, ctx) => {
          const hasQuote = Boolean(value.prepared_quote_id || value.quote_id);
          const hasSelection = Boolean(
            value.hotel_id && value.room_id && value.rate_id && value.checkin && value.checkout
          );

          if (!hasQuote && !hasSelection) {
            ctx.addIssue({
              code: "custom",
              path: ["prepared_quote_id"],
              message:
                "Provide prepared_quote_id or quote_id, or provide hotel_id + room_id + rate_id + checkin + checkout so create_booking can mint a fresh quote automatically.",
            });
          }
        })
    ),
  },
  async (args, extra) => {
    const requestPrincipal = extra?.bitvoyaAuth?.principal || null;
    const toolOptions = {
      execution_mode: bookingExecutionMode,
      config,
      request_principal: requestPrincipal,
    };

    const providedQuoteId = args.prepared_quote_id || args.quote_id || null;
    const providedQuote = providedQuoteId ? store.getQuote(providedQuoteId) : null;
    const hasUsableQuote = Boolean(providedQuote && providedQuote.expires_at_ms > Date.now());
    const hasSelection = Boolean(
      args.hotel_id && args.room_id && args.rate_id && args.checkin && args.checkout
    );

    let effectivePreparedQuoteId = hasUsableQuote ? providedQuote.quote_id : null;
    let quoteSource = hasUsableQuote ? "existing_prepared_quote" : "fresh_quote_required";

    if (!effectivePreparedQuoteId) {
      if (!hasSelection) {
        const payload = await createBookingIntent(
          store,
          {
            prepared_quote_id: providedQuoteId || undefined,
            quote_id: providedQuoteId || undefined,
            payment_method: args.payment_method,
            guest_primary: args.guest_primary,
            contact: args.contact,
            companions: args.companions,
            children: args.children,
            arrival_time: args.arrival_time,
            special_requests: args.special_requests,
            user_info: args.user_info,
          },
          toolOptions
        );

        return asTextResult(
          rewriteToolResult(payload, {
            tool: "create_booking",
            selection_hint:
              "create_booking could not auto-refresh the quote because hotel_id, room_id, rate_id, checkin, and checkout were not all supplied.",
            data_patch: {
              create_booking_flow: {
                quote_source: "missing_or_stale_quote_without_selection",
                provided_quote_id: providedQuoteId,
                prepared_quote_id: null,
                auto_prepared_quote: false,
              },
            },
          })
        );
      }

      const quotePayload = await prepareBookingQuote(
        api,
        db,
        store,
        config,
        {
          hotel_id: args.hotel_id,
          hotel_name: args.hotel_name || null,
          city_name: args.city_name || null,
          room_id: args.room_id,
          rate_id: args.rate_id,
          checkin: args.checkin,
          checkout: args.checkout,
          adult_num: args.adult_num || 2,
          child_num: args.child_num || 0,
          room_num: args.room_num || 1,
        },
        toolOptions
      );

      effectivePreparedQuoteId =
        quotePayload?.data?.prepared_quote_id || quotePayload?.data?.quote?.quote_id || null;

      if (!effectivePreparedQuoteId) {
        return asTextResult(
          rewriteToolResult(quotePayload, {
            tool: "create_booking",
            selection_hint:
              "create_booking stopped before intent creation because a fresh live quote could not be prepared.",
            data_patch: {
              create_booking_flow: {
                quote_source: "quote_preparation_failed",
                provided_quote_id: providedQuoteId,
                prepared_quote_id: null,
                auto_prepared_quote: false,
              },
            },
          })
        );
      }

      quoteSource = "fresh_quote_prepared";
    }

    const payload = await createBookingIntent(
      store,
      {
        prepared_quote_id: effectivePreparedQuoteId,
        payment_method: args.payment_method,
        guest_primary: args.guest_primary,
        contact: args.contact,
        companions: args.companions,
        children: args.children,
        arrival_time: args.arrival_time,
        special_requests: args.special_requests,
        user_info: args.user_info,
      },
      toolOptions
    );

    return asTextResult(
      rewriteToolResult(payload, {
        tool: "create_booking",
        selection_hint:
          quoteSource === "fresh_quote_prepared"
            ? `create_booking automatically minted fresh prepared_quote_id ${effectivePreparedQuoteId} before creating the booking intent.`
            : `create_booking used prepared_quote_id ${effectivePreparedQuoteId} directly.`,
        data_patch: {
          create_booking_flow: {
            quote_source: quoteSource,
            provided_quote_id: providedQuoteId,
            prepared_quote_id: effectivePreparedQuoteId,
            auto_prepared_quote: quoteSource === "fresh_quote_prepared",
          },
        },
      })
    );
  }
);

server.registerTool(
  "prepare_booking_quote",
  {
    description:
      `Low-level quote-freeze tool. Re-fetch live room inventory and freeze a short-lived booking quote for a specific hotel / room / rate selection. This is the only public MCP tool that mints a booking quote usable by create_booking_intent. If guest and contact details are already known and you want the shortest public booking path, prefer create_booking instead. ${relativeDateInstruction}`,
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    inputSchema: z.preprocess(
      (input) => normalizePrepareBookingQuoteArgs(input),
      z.object({
        hotel_id: z.string().min(1).describe("Bitvoya hotel id."),
        hotel_name: z.string().min(1).optional().describe("Optional hotel name hint for recovering canonical live hotel id."),
        city_name: z.string().min(1).optional().describe("Optional city name hint paired with hotel_name for identity recovery."),
        room_id: z.string().min(1).describe("Selected room id."),
        rate_id: z.string().min(1).describe("Selected rate id from get_hotel_rooms."),
        checkin: z.string().min(1).describe(`Stay start date in YYYY-MM-DD. ${relativeDateInstruction}`),
        checkout: z.string().min(1).describe(`Stay end date in YYYY-MM-DD. ${relativeDateInstruction}`),
        adult_num: z.number().int().min(1).max(8).optional().describe("Number of adults."),
        child_num: z.number().int().min(0).max(6).optional().describe("Number of children."),
        room_num: z.number().int().min(1).max(4).optional().describe("Number of rooms requested."),
      })
    ),
  },
  async ({ hotel_id, hotel_name, city_name, room_id, rate_id, checkin, checkout, adult_num, child_num, room_num }, extra) => {
    const payload = await prepareBookingQuote(api, db, store, config, {
      hotel_id,
      hotel_name,
      city_name,
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
      "Low-level specialist tool for agents that already hold a fresh prepared_quote_id from prepare_booking_quote in the same MCP runtime. Only use the quote returned by prepare_booking_quote; never pass search-context or frontend page tokens. If you only have hotel_id / room_id / rate_id plus traveler details, prefer create_booking instead.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    inputSchema: z.preprocess(
      (input) => normalizeCreateBookingIntentArgs(input),
      z
        .object({
          prepared_quote_id: z
            .string()
            .min(1)
            .optional()
            .describe("Preferred prepared booking quote id from prepare_booking_quote. This is the only quote input that should be used for booking execution."),
          quote_id: z
            .string()
            .min(1)
            .optional()
            .describe("Deprecated alias for prepared_quote_id. Only pass the short-lived server-owned quote returned by prepare_booking_quote; never pass search-context or frontend quote-like tokens."),
          payment_method: paymentMethodSchema.describe("Selected payment path."),
          guest_primary: guestPrimaryInputSchema,
          contact: contactInputSchema,
          companions: companionsInputSchema,
          children: childrenInputSchema,
          arrival_time: z.string().optional(),
          special_requests: z.array(z.string().min(1)).optional(),
          user_info: userInfoInputSchema,
        })
        .refine((value) => Boolean(value.prepared_quote_id || value.quote_id), {
          message: "One of prepared_quote_id or quote_id is required.",
          path: ["prepared_quote_id"],
        })
    ),
  },
  async ({ prepared_quote_id, quote_id, payment_method, guest_primary, contact, companions, children, arrival_time, special_requests, user_info }, extra) => {
    const payload = await createBookingIntent(store, {
      prepared_quote_id,
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
      "Inspect the current local state of a prepared booking quote or booking intent, including bridged backend order and payment-session state when available.",
    outputSchema: agenticToolOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: z.preprocess(
      (input) => normalizeBookingStateArgs(input),
      z
        .object({
          prepared_quote_id: z
            .string()
            .optional()
            .describe("Preferred prepared booking quote id from prepare_booking_quote."),
          quote_id: z
            .string()
            .optional()
            .describe("Deprecated alias for prepared_quote_id."),
          intent_id: z.string().optional().describe("Intent id."),
        })
        .refine((value) => Boolean(value.intent_id || value.prepared_quote_id || value.quote_id), {
          message: "One of intent_id, prepared_quote_id, or quote_id is required.",
          path: ["intent_id"],
        })
    ),
  },
  async ({ prepared_quote_id, quote_id, intent_id }) => {
    const payload = await getBookingState(store, {
      prepared_quote_id,
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
    async ({ intent_id }, extra) => {
      const payload = await submitBookingIntent(api, store, config, {
        intent_id,
      }, {
        execution_mode: bookingExecutionMode,
        config,
        request_principal: extra?.bitvoyaAuth?.principal || null,
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
    async ({ intent_id, success_url, cancel_url }, extra) => {
      const payload = await createBookingPaymentSession(api, store, {
        intent_id,
        success_url,
        cancel_url,
      }, {
        execution_mode: bookingExecutionMode,
        config,
        request_principal: extra?.bitvoyaAuth?.principal || null,
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
    async ({ intent_id }, extra) => {
      const payload = await refreshBookingState(api, store, {
        intent_id,
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
    description: "Grounding-only hotel search without live product inventory. Use this only when live availability and pricing are not required, or when the workflow explicitly needs grounding fallback.",
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
    description: "Get a grounded Bitvoya hotel card with transport, traveler fit, and nearby POIs after a hotel candidate is already known. Not a primary first-step search tool.",
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
