import crypto from "node:crypto";
import { getHotelRooms } from "./hotels.mjs";
import { buildAgenticToolResult, buildNextTool } from "../agentic-output.mjs";
import { asArray, asNullableNumber, compactText, firstNonEmpty, roundNullableNumber } from "../format.mjs";
import { buildIntentSecureHandoff, buildQuoteSecureHandoff } from "../handoff.mjs";

const INTERNAL_EXECUTION_MODE = "internal_execution";
const EXECUTOR_HANDOFF_MODE = "executor_handoff";

function normalizeExecutionMode(optionsOrMode) {
  const mode =
    typeof optionsOrMode === "string"
      ? optionsOrMode
      : optionsOrMode?.execution_mode;

  return mode === EXECUTOR_HANDOFF_MODE ? EXECUTOR_HANDOFF_MODE : INTERNAL_EXECUTION_MODE;
}

function normalizeId(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function buildAccountBinding(options = {}) {
  const principal = options?.request_principal;

  if (!principal || typeof principal !== "object") {
    return null;
  }

  const scopes = Array.isArray(principal.scopes)
    ? principal.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
    : [];

  return {
    user_id: normalizeId(principal.user_id),
    account_id: normalizeId(principal.account_id),
    token_id: normalizeId(principal.token_id),
    token_type: normalizeId(principal.token_type),
    actor_type: normalizeId(principal.actor_type),
    scopes,
  };
}

function mergeUserInfoWithAccountBinding(userInfo, accountBinding) {
  const base =
    userInfo && typeof userInfo === "object" && !Array.isArray(userInfo)
      ? { ...userInfo }
      : {};

  if (!accountBinding) {
    return Object.keys(base).length > 0 ? base : null;
  }

  return {
    ...base,
    ...(accountBinding.user_id ? { id: accountBinding.user_id } : {}),
    ...(accountBinding.user_id ? { user_id: accountBinding.user_id } : {}),
    ...(accountBinding.account_id ? { account_id: accountBinding.account_id } : {}),
    ...(accountBinding.token_id ? { token_id: accountBinding.token_id } : {}),
    ...(accountBinding.token_type ? { token_type: accountBinding.token_type } : {}),
    ...(accountBinding.actor_type ? { actor_type: accountBinding.actor_type } : {}),
  };
}

function detectCardType(number) {
  const clean = String(number || "").replace(/\D/g, "");
  if (/^4/.test(clean)) return { type: "visa", name: "Visa" };
  if (/^5[1-5]/.test(clean)) return { type: "mastercard", name: "Mastercard" };
  if (/^3[47]/.test(clean)) return { type: "amex", name: "American Express" };
  if (/^6(?:011|5)/.test(clean)) return { type: "discover", name: "Discover" };
  if (/^(?:2131|1800|35)/.test(clean)) return { type: "jcb", name: "JCB" };
  if (/^62/.test(clean)) return { type: "unionpay", name: "UnionPay" };
  return { type: "unknown", name: "Unknown" };
}

function luhnCheck(number) {
  const clean = String(number || "").replace(/\D/g, "");
  if (!/^\d{13,19}$/.test(clean)) return false;

  let checksum = 0;
  let multiplier = 1;

  for (let index = clean.length - 1; index >= 0; index -= 1) {
    let value = Number(clean[index]) * multiplier;
    if (value > 9) value -= 9;
    checksum += value;
    multiplier = multiplier === 1 ? 2 : 1;
  }

  return checksum % 10 === 0;
}

function normalizeExpiry(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/);
  if (!match) {
    throw new Error("Expiry must be in MM/YY or MM/YYYY format.");
  }

  const month = match[1];
  const fullYear = match[2].length === 2 ? `20${match[2]}` : match[2];
  const normalized = `${month}/${fullYear.slice(-2)}`;

  return {
    expiry: normalized,
    expiry_month: month,
    expiry_year: fullYear,
  };
}

function maskCardNumber(number) {
  const clean = String(number || "").replace(/\D/g, "");
  if (clean.length <= 4) return clean;
  return `**** **** **** ${clean.slice(-4)}`;
}

function derivePaymentRequirement(quote, paymentMethod) {
  const displayTotal = quote?.pricing?.display_total_cny || 0;
  const supplierTotal = quote?.pricing?.supplier_total_cny || 0;
  const serviceFee = quote?.pricing?.service_fee_cny || 0;

  if (paymentMethod === "prepay") {
    return {
      payment_requirement: "full_payment",
      amount_due_now_cny: displayTotal,
      amount_due_at_hotel_cny: 0,
      requires_card_attachment: false,
      next_actions: ["submit_booking_intent", "create_booking_payment_session"],
    };
  }

  if (serviceFee > 0) {
    return {
      payment_requirement: "service_fee_only",
      amount_due_now_cny: serviceFee,
      amount_due_at_hotel_cny: supplierTotal,
      requires_card_attachment: true,
      next_actions: ["attach_booking_card", "submit_booking_intent", "create_booking_payment_session"],
    };
  }

  return {
    payment_requirement: "none",
    amount_due_now_cny: 0,
    amount_due_at_hotel_cny: supplierTotal,
    requires_card_attachment: true,
    next_actions: ["attach_booking_card", "submit_booking_intent"],
  };
}

function validateQuotePaymentSupport(quote, paymentMethod) {
  if (paymentMethod === "prepay" && !quote?.payment_options?.prepay_supported) {
    throw new Error("Selected rate does not support prepay.");
  }

  if (paymentMethod === "guarantee" && !quote?.payment_options?.guarantee_supported) {
    throw new Error("Selected rate does not support guarantee.");
  }
}

function requireGuestPrimary(guestPrimary) {
  const firstName = String(guestPrimary?.first_name || "").trim();
  const lastName = String(guestPrimary?.last_name || "").trim();

  if (!firstName || !lastName) {
    throw new Error("guest_primary.first_name and guest_primary.last_name are required.");
  }

  return {
    first_name: firstName,
    last_name: lastName,
    gender: guestPrimary?.gender || null,
    frequent_traveler: guestPrimary?.frequent_traveler || null,
    membership_level: guestPrimary?.membership_level || null,
  };
}

function composeFullPhone(contact) {
  const explicit = String(contact?.full_phone || "").trim();
  if (explicit) {
    return explicit;
  }

  const phone = String(contact?.phone || "").trim();
  if (!phone) {
    return null;
  }

  const prefix = String(contact?.custom_country_code || contact?.country_code || "").trim();
  if (!prefix) {
    return phone;
  }

  return `${prefix}${phone}`;
}

function requireContact(contact) {
  const email = String(contact?.email || "").trim();
  const phone = String(contact?.phone || "").trim();

  if (!email || !phone) {
    throw new Error("contact.email and contact.phone are required.");
  }

  return {
    email,
    phone,
    country_code: contact?.country_code || null,
    custom_country_code: contact?.custom_country_code || null,
    full_phone: composeFullPhone(contact),
  };
}

function normalizeCompanions(companions) {
  if (!Array.isArray(companions)) return [];

  return companions
    .map((item) => ({
      first_name: String(item?.first_name || "").trim(),
      last_name: String(item?.last_name || "").trim(),
      gender: item?.gender || null,
    }))
    .filter((item) => item.first_name && item.last_name);
}

function normalizeChildren(children) {
  if (!Array.isArray(children)) return [];

  return children
    .map((item, index) => ({
      child_number: index + 1,
      age: asNullableNumber(item?.age),
    }))
    .filter((item) => Number.isFinite(item.age) && item.age >= 0 && item.age <= 17);
}

function buildChildrenDetails(children) {
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .map((item, index) => ({
      childNumber: index + 1,
      age: asNullableNumber(item?.age),
    }))
    .filter((item) => Number.isFinite(item.age) && item.age >= 0 && item.age <= 17);
}

function buildGuestSnapshot({ guestPrimary, contact, companions, children, arrivalTime, specialRequests }) {
  return {
    guest_primary: guestPrimary,
    contact,
    companions,
    children,
    arrival_time: arrivalTime || null,
    special_requests: specialRequests,
  };
}

function buildLegacySubmitPreview({ quote, intent, cardBinding = null }) {
  const paymentMethod = intent.payment_method;
  const isGuaranteeWithFee =
    paymentMethod === "guarantee" && Number(quote?.pricing?.service_fee_cny || 0) > 0;

  const guestPrimary = intent?.guest_snapshot?.guest_primary || {};
  const contact = intent?.guest_snapshot?.contact || {};
  const companions = intent?.guest_snapshot?.companions || [];
  const children = intent?.guest_snapshot?.children || [];
  const childrenDetails = buildChildrenDetails(children);

  return {
    userInfo: intent.user_info || null,
    hotel: {
      id: quote.hotel_snapshot.hotel_id,
      name: quote.hotel_snapshot.hotel_name,
      nameEn: quote.hotel_snapshot.hotel_name_en,
      address: quote.hotel_snapshot.address,
      image: quote.hotel_snapshot.hero_image_url,
      telephone: quote.hotel_snapshot.telephone,
    },
    room: {
      id: quote.room_snapshot.room_id,
      name: quote.room_snapshot.room_name,
      nameEn: quote.room_snapshot.room_name_en,
      image: quote.room_snapshot.image_url,
    },
    rateDetail: {
      id: quote.rate_snapshot.rate_id,
      name: quote.rate_snapshot.rate_name,
      totalPriceCny: quote.pricing.supplier_total_cny,
      taxPriceCny: quote.pricing.supplier_tax_and_fee_cny,
      breakfast: quote.rate_snapshot.breakfast,
      cancelPolicy: {
        cancelTime: quote.cancellation_policy?.free_cancel_until || null,
        penalty: quote.cancellation_policy?.penalty_cny || null,
        unit: quote.cancellation_policy?.penalty_currency || quote.pricing.currency,
        utc: quote.cancellation_policy?.timezone || null,
      },
      paymentType: {
        allowPayAll: quote.payment_options.prepay_supported ? 1 : 0,
        allowCreditGuarantee: quote.payment_options.guarantee_supported ? 1 : 0,
      },
      currency: quote.pricing.currency,
      service_fee: {
        amount: quote.pricing.service_fee_cny,
      },
      total_with_service_fee: quote.pricing.display_total_cny,
      interests: quote.benefits_snapshot.interests,
      promotions: quote.benefits_snapshot.promotions,
    },
    searchParams: {
      checkin: quote.stay.checkin,
      checkout: quote.stay.checkout,
      nights: quote.stay.nights,
      rooms: quote.stay.room_num,
      adults: quote.stay.adult_num,
      children: quote.stay.child_num,
    },
    guestInfo: {
      "guest-first-name": guestPrimary.first_name,
      "guest-last-name": guestPrimary.last_name,
      "guest-gender": guestPrimary.gender,
      "frequent-traveler": guestPrimary.frequent_traveler,
      "membership-level": guestPrimary.membership_level,
      "country-code": contact.country_code,
      "custom-country-code": contact.custom_country_code,
      phone: contact.phone,
      email: contact.email,
      "arrival-time": intent.guest_snapshot.arrival_time,
      children: String(children.length),
      childrenDetails,
      "additional-requests": intent.guest_snapshot.special_requests.join("; "),
      paymentMethod,
      "payment-method": paymentMethod,
      fullPhone: contact.full_phone,
      paymentType:
        paymentMethod === "prepay"
          ? { method: "prepay", name: "全款预付", description: "立即支付全额费用" }
          : { method: "guarantee", name: "信用卡担保", description: "到店支付" },
      companions: companions.map((item) => ({
        firstName: item.first_name,
        lastName: item.last_name,
        gender: item.gender,
      })),
      "children-ages": children.map((item) => item.age),
      "special-requests": intent.guest_snapshot.special_requests,
      "companion-first-name": companions[0]?.first_name || "",
      "companion-last-name": companions[0]?.last_name || "",
      "companion-gender": companions[0]?.gender || "",
      creditCardInfo: cardBinding
        ? {
            cardNumberMasked: cardBinding.masked_number,
            cardNumberLast4: cardBinding.last4,
            expiry: cardBinding.expiry,
            expiryMonth: cardBinding.expiry_month,
            expiryYear: cardBinding.expiry_year,
            cardType: cardBinding.card_type,
            cardBrand: cardBinding.card_brand,
          }
        : null,
    },
    paymentInfo: {
      method: paymentMethod,
      type:
        paymentMethod === "prepay"
          ? { method: "prepay", name: "全款预付", description: "立即支付全额费用" }
          : { method: "guarantee", name: "信用卡担保", description: "到店支付" },
    },
    currency: quote.pricing.currency,
    interests: quote.benefits_snapshot.interests,
    promotions: quote.benefits_snapshot.promotions,
    serviceFeeAmount: quote.pricing.service_fee_cny || 0,
    requiresServiceFeePayment: isGuaranteeWithFee,
    flowType: isGuaranteeWithFee ? "guarantee_with_service_fee" : "standard",
    timestamp: intent.created_at,
  };
}

function buildQuoteSummary(quote) {
  return {
    quote_id: quote.quote_id,
    created_at: quote.created_at,
    expires_at: quote.expires_at,
    hotel_id: quote.hotel_id,
    room_id: quote.room_id,
    rate_id: quote.rate_id,
    stay: quote.stay,
    pricing: quote.pricing,
    payment_options: quote.payment_options,
    payment_scenarios: quote.payment_scenarios,
    cancellation_policy: quote.cancellation_policy,
    benefits_snapshot: quote.benefits_snapshot,
    validation_flags: quote.validation_flags,
    hotel_snapshot: quote.hotel_snapshot,
    room_snapshot: quote.room_snapshot,
    rate_snapshot: quote.rate_snapshot,
  };
}

function roundMoney(value) {
  return roundNullableNumber(value, 2);
}

function formatMoneyLabel(value, currency = "CNY") {
  const rounded = roundMoney(value);
  if (rounded === null) {
    return null;
  }

  return `${rounded} ${currency || "CNY"}`;
}

function classifyQuoteId(quoteId) {
  const normalized = normalizeId(quoteId);
  if (!normalized) {
    return {
      quote_id: null,
      origin: "missing_quote_id",
      is_runtime_store_id: false,
    };
  }

  if (/^quote_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    return {
      quote_id: normalized,
      origin: "runtime_store_quote_id",
      is_runtime_store_id: true,
    };
  }

  if (/^quote_[A-Za-z0-9_-]+$/.test(normalized)) {
    return {
      quote_id: normalized,
      origin: "frontend_or_foreign_quote_id",
      is_runtime_store_id: false,
    };
  }

  return {
    quote_id: normalized,
    origin: "unknown_quote_id_format",
    is_runtime_store_id: false,
  };
}

function buildMissingQuoteRecoveryResult(tool, params = {}, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const quoteIdInfo = classifyQuoteId(params?.quote_id);
  const paymentMethod = normalizeId(params?.payment_method);
  const isForeignQuote = quoteIdInfo.origin === "frontend_or_foreign_quote_id";
  const isRuntimeQuote = quoteIdInfo.origin === "runtime_store_quote_id";
  const summary =
    isForeignQuote
      ? `Requested quote_id ${quoteIdInfo.quote_id} is not a current MCP server-owned quote. It looks like a frontend or foreign-system quote token, so ${tool} cannot continue from it directly. Prepare a fresh live quote first.`
      : isRuntimeQuote
        ? `Requested quote_id ${quoteIdInfo.quote_id} is not available in the current MCP runtime store. It may already be expired or may have been minted by another deployment.`
        : `Requested quote_id ${quoteIdInfo.quote_id || "N/A"} is not available for booking execution in the current MCP runtime. Prepare a fresh live quote first.`;
  const presenterLines = [
    "Open with: The requested quote_id is not usable for booking execution in the current MCP runtime.",
    isForeignQuote
      ? "Angle: This looks like a frontend or foreign-system quote token, not the short-lived server-owned quote_id minted by prepare_booking_quote."
      : "Angle: Current MCP quote_ids are short-lived and runtime-scoped, so missing ids should be treated as expired-or-foreign rather than silently reused.",
    paymentMethod
      ? `Decision split: Mint a fresh quote first, then retry create_booking_intent with payment_method ${paymentMethod}.`
      : "Decision split: Mint a fresh quote first, then retry create_booking_intent with the intended payment_method.",
    "Ask next: Confirm the current live hotel_id / room_id / rate_id selection before re-creating the quote.",
  ];

  return buildAgenticToolResult({
    tool,
    status: "partial",
    intent: tool === "get_booking_state" ? "booking_state_inspection" : "booking_intent_execution",
    summary,
    recommended_next_tools: [
      buildNextTool("get_hotel_rooms", "Reload live room inventory and current ids before creating a fresh quote.", [
        "hotel_id",
        "checkin",
        "checkout",
      ]),
      buildNextTool("prepare_booking_quote", "Mint a fresh short-lived server-owned quote before creating booking intent.", [
        "hotel_id",
        "room_id",
        "rate_id",
        "checkin",
        "checkout",
      ]),
    ],
    warnings: [
      "create_booking_intent only accepts active server-owned quote_id values minted by prepare_booking_quote in this MCP deployment.",
      ...(isForeignQuote
        ? ["Do not pass frontend page quote tokens or foreign-system quote ids directly into create_booking_intent."]
        : []),
    ],
    pricing_notes: [
      "Quote-scoped pricing is only trustworthy while the MCP server-owned quote is still active.",
    ],
    selection_hints: [
      paymentMethod
        ? `After preparing a fresh quote, reuse payment_method ${paymentMethod} with the same guest/contact payload.`
        : "After preparing a fresh quote, retry create_booking_intent with the intended payment_method and the same guest/contact payload.",
      "Do not assume old quote_id values still map to current live room/rate inventory.",
      ...(executionMode === EXECUTOR_HANDOFF_MODE
        ? [
            "In executor_handoff mode, refresh the quote first, then create a new intent and continue on Bitvoya-hosted secure checkout.",
          ]
        : []),
    ],
    data: {
      found: false,
      entity: "quote",
      reason: "quote_unavailable",
      requested_quote: {
        quote_id: quoteIdInfo.quote_id,
        quote_id_origin: quoteIdInfo.origin,
        payment_method: paymentMethod,
      },
      booking_readiness: {
        status: "needs_fresh_quote",
      },
      agent_brief: {
        mode: "quote_unavailable",
        booking_readiness: {
          status: "needs_fresh_quote",
        },
        recommended_opening: "The requested quote_id is not usable for booking execution in the current MCP runtime.",
        recommended_angle: presenterLines[1],
        next_question: "Confirm the current live hotel_id / room_id / rate_id selection before re-creating the quote.",
        presenter_lines: presenterLines,
      },
    },
  });
}

function rateMatchesRequestedId(rate, requestedRateId) {
  const requestedId = normalizeId(requestedRateId);
  if (!requestedId) {
    return false;
  }

  return [rate?.rate_id, rate?.supplier_rate_id].some((value) => normalizeId(value) === requestedId);
}

function roomMatchesRequestedId(room, requestedRoomId) {
  const requestedId = normalizeId(requestedRoomId);
  if (!requestedId) {
    return false;
  }

  return (
    normalizeId(room?.room_id) === requestedId ||
    asArray(room?.rates).some((rate) => normalizeId(rate?.room_id) === requestedId)
  );
}

function buildLiveSelectionCandidates(rooms, { room_limit = 3, rate_limit_per_room = 2 } = {}) {
  return asArray(rooms)
    .slice(0, room_limit)
    .map((room) => ({
      room_id: normalizeId(room?.room_id),
      room_name: firstNonEmpty(room?.room_name, room?.room_name_en),
      room_name_en: firstNonEmpty(room?.room_name_en),
      cheapest_display_total_cny: roundMoney(room?.cheapest_display_total_cny),
      total_rate_options: asArray(room?.rates).length,
      rates: asArray(room?.rates)
        .slice(0, rate_limit_per_room)
        .map((rate) => ({
          room_id: normalizeId(rate?.room_id),
          rate_id: normalizeId(rate?.rate_id),
          supplier_rate_id: normalizeId(rate?.supplier_rate_id),
          rate_name: firstNonEmpty(rate?.rate_name, rate?.rate_name_en),
          rate_name_en: firstNonEmpty(rate?.rate_name_en),
          display_total_cny: roundMoney(rate?.pricing?.display_total_cny),
          service_fee_cny: roundMoney(rate?.pricing?.service_fee_cny),
          free_cancel_until: firstNonEmpty(rate?.cancellation?.free_cancel_until),
          payment_options: rate?.payment_options || null,
        })),
    }));
}

function resolveRequestedLiveSelection(rooms, params) {
  const requestedRoomId = normalizeId(params?.room_id);
  const requestedRateId = normalizeId(params?.rate_id);
  const flattenedRates = asArray(rooms).flatMap((room) =>
    asArray(room?.rates).map((rate) => ({
      room,
      rate,
    }))
  );
  const exactRoomMatches = requestedRoomId
    ? asArray(rooms).filter((room) => normalizeId(room?.room_id) === requestedRoomId)
    : [];
  const roomMatches = requestedRoomId
    ? asArray(rooms).filter((room) => roomMatchesRequestedId(room, requestedRoomId))
    : [];
  const rateMatches = requestedRateId
    ? flattenedRates.filter((entry) => rateMatchesRequestedId(entry?.rate, requestedRateId))
    : [];

  let selectedRoom = null;
  let selectedRate = null;
  let matchStrategy = null;

  if (roomMatches.length === 1) {
    selectedRoom = roomMatches[0];
    selectedRate = asArray(selectedRoom?.rates).find((rate) => rateMatchesRequestedId(rate, requestedRateId)) || null;
    if (selectedRate) {
      matchStrategy =
        exactRoomMatches.length === 1 ? "room_and_rate_exact" : "room_recovered_rate_exact";
    }
  }

  if (!selectedRate && rateMatches.length === 1) {
    selectedRoom = rateMatches[0].room;
    selectedRate = rateMatches[0].rate;
    matchStrategy = "rate_exact_global";
  }

  return {
    requested_room_id: requestedRoomId,
    requested_rate_id: requestedRateId,
    selected_room: selectedRoom,
    selected_rate: selectedRate,
    match_strategy: matchStrategy,
    room_match_status:
      !requestedRoomId
        ? "unspecified"
        : exactRoomMatches.length === 1
          ? "exact"
          : roomMatches.length === 1
            ? "matched_via_rate_room_id"
            : roomMatches.length > 1
              ? "ambiguous"
              : "not_found",
    rate_match_status:
      !requestedRateId
        ? "unspecified"
        : rateMatches.length === 1
          ? "exact"
          : rateMatches.length > 1
            ? "ambiguous"
            : "not_found",
    room_match_candidates: roomMatches.slice(0, 3).map((room) => ({
      room_id: normalizeId(room?.room_id),
      room_name: firstNonEmpty(room?.room_name, room?.room_name_en),
    })),
    rate_match_candidates: rateMatches.slice(0, 3).map((entry) => ({
      room_id: normalizeId(entry?.room?.room_id),
      room_name: firstNonEmpty(entry?.room?.room_name, entry?.room?.room_name_en),
      rate_id: normalizeId(entry?.rate?.rate_id),
      supplier_rate_id: normalizeId(entry?.rate?.supplier_rate_id),
      rate_name: firstNonEmpty(entry?.rate?.rate_name, entry?.rate?.rate_name_en),
    })),
  };
}

function buildQuotePaymentPath(quote, paymentMethod, options = {}) {
  if (!["prepay", "guarantee"].includes(paymentMethod)) {
    return null;
  }

  const executionMode = normalizeExecutionMode(options);
  const supported =
    paymentMethod === "prepay"
      ? Boolean(quote?.payment_options?.prepay_supported)
      : Boolean(quote?.payment_options?.guarantee_supported);

  if (!supported) {
    return {
      payment_method: paymentMethod,
      supported: false,
      reason_not_supported:
        paymentMethod === "prepay"
          ? "Selected rate does not expose prepay support."
          : "Selected rate does not expose guarantee support.",
    };
  }

  const requirement = derivePaymentRequirement(quote, paymentMethod);
  const requiresPaymentSession = ["full_payment", "service_fee_only"].includes(requirement.payment_requirement);
  const internalNextActions = requirement.next_actions;
  const travelerInputsRequired = [
    "guest_primary.first_name",
    "guest_primary.last_name",
    "contact.email",
    "contact.phone",
  ];

  if (executionMode === INTERNAL_EXECUTION_MODE && requirement.requires_card_attachment) {
    travelerInputsRequired.push("card pan + expiry or card_reference_id after intent creation");
  }

  const path = {
    payment_method: paymentMethod,
    supported: true,
    payment_requirement: requirement.payment_requirement,
    amount_due_now_cny: requirement.amount_due_now_cny,
    amount_due_at_hotel_cny: requirement.amount_due_at_hotel_cny,
    requires_card_attachment: requirement.requires_card_attachment,
    requires_payment_session: requiresPaymentSession,
    next_actions: executionMode === INTERNAL_EXECUTION_MODE ? internalNextActions : ["create_booking_intent"],
    traveler_inputs_required: travelerInputsRequired,
    operational_notes:
      paymentMethod === "prepay"
        ? [
            "Prepay uses the guest-facing display_total_cny as the expected due-now amount.",
            executionMode === INTERNAL_EXECUTION_MODE
              ? "Card attachment is not required before submission because payment happens through the payment session flow."
              : "After create_booking_intent, the traveler should continue through Bitvoya-hosted secure checkout while Bitvoya internal executor remains responsible for backend submission and payment-session creation.",
          ]
        : [
            "Guarantee may require only service_fee_cny now while supplier_total_cny remains payable at hotel.",
            executionMode === INTERNAL_EXECUTION_MODE
              ? "A guarantee card must be attached after create_booking_intent and before submit_booking_intent."
              : "After create_booking_intent, Bitvoya-hosted secure checkout must collect the guarantee card and continue fulfillment outside the public MCP.",
          ],
  };

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    path.internal_executor_next_actions = internalNextActions;
    path.internal_executor_required_inputs = buildActionRequiredInputs(internalNextActions, {
      intentIdLabel: "intent_id (after create_booking_intent)",
    });
  }

  return path;
}

function buildQuoteRequiredInputs(quote, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const requirements = {
    create_booking_intent: [
      "quote_id",
      "payment_method",
      "guest_primary.first_name",
      "guest_primary.last_name",
      "contact.email",
      "contact.phone",
    ],
    optional_at_intent_creation: [
      "guest_primary.gender",
      "guest_primary.frequent_traveler",
      "guest_primary.membership_level",
      "companions[]",
      "children[]",
      "arrival_time",
      "special_requests[]",
      "user_info",
    ],
  };

  if (executionMode === INTERNAL_EXECUTION_MODE) {
    requirements.attach_booking_card =
      quote?.payment_options?.guarantee_supported
        ? [
            "intent_id",
            "card_reference_id or pan",
            "expiry",
          ]
        : [];
  }

  return requirements;
}

function buildQuoteConfirmationPack(quote) {
  return {
    quote_id: quote.quote_id,
    expires_at: quote.expires_at,
    stay: quote.stay,
    hotel: {
      hotel_id: quote.hotel_snapshot.hotel_id,
      hotel_name: quote.hotel_snapshot.hotel_name,
      hotel_name_en: quote.hotel_snapshot.hotel_name_en,
      city: quote.hotel_snapshot.city,
      brand: quote.hotel_snapshot.brand,
      address: quote.hotel_snapshot.address,
      telephone: quote.hotel_snapshot.telephone,
      membership_benefits: quote.hotel_snapshot.membership_benefits,
      grounding_excerpt: quote.hotel_snapshot.grounding_excerpt,
    },
    room: quote.room_snapshot,
    rate: quote.rate_snapshot,
    pricing: quote.pricing,
    payment_options: quote.payment_options,
    payment_scenarios: quote.payment_scenarios,
    cancellation_policy: quote.cancellation_policy,
    benefits_snapshot: quote.benefits_snapshot,
  };
}

function computeQuoteState(quote) {
  const expiresAtMs = asNullableNumber(quote?.expires_at_ms) ?? Date.parse(String(quote?.expires_at || ""));
  const quoteValidNow = Number.isFinite(expiresAtMs) ? expiresAtMs > Date.now() : false;
  const secondsUntilExpiry =
    Number.isFinite(expiresAtMs) && quoteValidNow
      ? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000))
      : 0;

  return {
    status: quoteValidNow ? "active" : "expired",
    quote_valid_now: quoteValidNow,
    expires_at: quote?.expires_at || null,
    seconds_until_expiry: secondsUntilExpiry,
  };
}

function buildQuoteExecutionBoundary(quote, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const quoteState = computeQuoteState(quote);
  const boundary = {
    execution_mode: executionMode,
    sensitive_tools_exposed: executionMode === INTERNAL_EXECUTION_MODE,
    booking_completion_available_in_this_mcp: executionMode === INTERNAL_EXECUTION_MODE,
    public_mcp_scope: ["prepare_booking_quote", "create_booking_intent", "get_booking_state"],
  };

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    boundary.handoff_ready = quoteState.quote_valid_now;
    boundary.fulfillment_owner = "bitvoya_internal_executor";
    boundary.public_completion_surface = "bitvoya_hosted_secure_checkout";
    boundary.internal_executor_scope = [
      "Collect guarantee-card details when required.",
      "Submit prepared booking intents into the legacy Bitvoya booking backend.",
      "Create payment sessions when due-now payment is required.",
      "Refresh backend booking and payment state after submission.",
    ];
  }

  return boundary;
}

function buildQuoteStateResult(tool, quote, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const quoteSummary = buildQuoteSummary(quote);
  const quoteState = computeQuoteState(quote);
  const prepayPath = buildQuotePaymentPath(quote, "prepay", { execution_mode: executionMode });
  const guaranteePath = buildQuotePaymentPath(quote, "guarantee", { execution_mode: executionMode });
  const secureHandoff = buildQuoteSecureHandoff(quote, options);

  return buildAgenticToolResult({
    tool,
    status: quoteState.quote_valid_now ? "ok" : "partial",
    intent: "booking_state_inspection",
    summary: quoteState.quote_valid_now
      ? `Loaded quote ${quote.quote_id} for ${quote.hotel_snapshot.hotel_name} / ${quote.rate_snapshot.rate_name}. Quote is active until ${quote.expires_at}.`
      : `Loaded quote ${quote.quote_id} for ${quote.hotel_snapshot.hotel_name} / ${quote.rate_snapshot.rate_name}, but it is expired as of ${quote.expires_at}.`,
    recommended_next_tools: quoteState.quote_valid_now
      ? [
          buildNextTool(
            "create_booking_intent",
            "Use this active quote as the source of truth for traveler details and payment-path selection.",
            ["quote_id", "payment_method", "guest_primary", "contact"]
          ),
        ]
      : [
          buildNextTool(
            "prepare_booking_quote",
            "Re-freeze the room/rate selection because this quote is no longer valid for booking execution.",
            ["hotel_id", "room_id", "rate_id", "checkin", "checkout"]
          ),
          buildNextTool(
            "get_hotel_rooms",
            "Recheck live inventory and price semantics before regenerating a quote.",
            ["hotel_id", "checkin", "checkout"]
          ),
        ],
    pricing_notes: [
      "Frozen quote pricing remains aligned to display_total_cny / supplier_total_cny / service_fee_cny semantics at quote-creation time.",
    ],
    selection_hints: [
      "Only use an active quote_id for create_booking_intent.",
      "If the quote is expired, regenerate it instead of continuing with the old quote snapshot.",
      ...(executionMode === EXECUTOR_HANDOFF_MODE
        ? [
            "In executor_handoff mode, public agents stop at create_booking_intent, surface data.secure_handoff, and then inspect later state with get_booking_state.",
          ]
        : []),
    ],
    warnings: quoteState.quote_valid_now ? [] : ["Quote is expired and should not be used for booking execution."],
    entity_refs: {
      hotel_ids: [quote.hotel_snapshot?.hotel_id],
      city_ids: [quote.hotel_snapshot?.city?.source_city_id],
      room_ids: [quote.room_snapshot?.room_id],
      rate_ids: [quote.rate_snapshot?.rate_id],
      tripwiki_hotel_ids: [quote.hotel_snapshot?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [quote.hotel_snapshot?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      entity: "quote",
      quote: quoteSummary,
      quote_state: quoteState,
      confirmation_pack: buildQuoteConfirmationPack(quote),
      payment_paths: {
        prepay: prepayPath,
        guarantee: guaranteePath,
      },
      required_inputs: buildQuoteRequiredInputs(quote, { execution_mode: executionMode }),
      execution_boundary: buildQuoteExecutionBoundary(quote, options),
      secure_handoff: secureHandoff,
    },
  });
}

function buildActionRequiredInputs(actions, options = {}) {
  const intentIdLabel = options.intentIdLabel || "intent_id";
  const requirements = {};
  const uniqueActions = Array.from(new Set(Array.isArray(actions) ? actions : []));

  if (uniqueActions.includes("prepare_booking_quote")) {
    requirements.prepare_booking_quote = [
      "hotel_id",
      "room_id",
      "rate_id",
      "checkin",
      "checkout",
    ];
  }

  if (uniqueActions.includes("attach_booking_card")) {
    requirements.attach_booking_card = [intentIdLabel, "card_reference_id or pan", "expiry"];
  }

  if (uniqueActions.includes("submit_booking_intent")) {
    requirements.submit_booking_intent = [intentIdLabel];
  }

  if (uniqueActions.includes("create_booking_payment_session")) {
    requirements.create_booking_payment_session = [intentIdLabel];
  }

  if (uniqueActions.includes("refresh_booking_state")) {
    requirements.refresh_booking_state = [intentIdLabel];
  }

  return requirements;
}

function buildInternalIntentNextActions(intent, readyChecks = null) {
  const normalizedIntent = normalizeIntentState(intent);
  const checks = readyChecks || buildIntentReadyChecks(normalizedIntent);

  if (!checks.order_created && !checks.quote_still_valid) {
    return ["prepare_booking_quote"];
  }

  if (normalizedIntent.requires_card_attachment && !checks.card_attached) {
    return ["attach_booking_card"];
  }

  if (!checks.order_created) {
    return ["submit_booking_intent"];
  }

  if (checks.payment_session_required && !checks.payment_session_created) {
    return ["create_booking_payment_session", "refresh_booking_state"];
  }

  return ["refresh_booking_state"];
}

function buildVisibleIntentNextActions(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  if (executionMode === INTERNAL_EXECUTION_MODE) {
    return intentSummary?.internal_next_actions || [];
  }

  const readyChecks = intentSummary?.ready_checks || {};
  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    return ["prepare_booking_quote", "get_hotel_rooms"];
  }

  return ["get_booking_state"];
}

function buildIntentSummary(intent, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const normalizedIntent = normalizeIntentState(intent);
  const readyChecks = buildIntentReadyChecks(normalizedIntent);
  const internalNextActions = buildInternalIntentNextActions(normalizedIntent, readyChecks);

  return {
    intent_id: normalizedIntent.intent_id,
    quote_id: normalizedIntent.quote_id,
    created_at: normalizedIntent.created_at,
    updated_at: normalizedIntent.updated_at,
    status: normalizedIntent.status,
    payment_method: normalizedIntent.payment_method,
    payment_requirement: normalizedIntent.payment_requirement,
    amount_due_now_cny: normalizedIntent.amount_due_now_cny,
    amount_due_at_hotel_cny: normalizedIntent.amount_due_at_hotel_cny,
    requires_card_attachment: normalizedIntent.requires_card_attachment,
    card_attachment: normalizedIntent.card_attachment,
    next_actions:
      executionMode === INTERNAL_EXECUTION_MODE
        ? internalNextActions
        : buildVisibleIntentNextActions({
            ready_checks: readyChecks,
            internal_next_actions: internalNextActions,
          }, { execution_mode: executionMode }),
    internal_next_actions: internalNextActions,
    ready_checks: readyChecks,
    backend_order: normalizedIntent.backend_order,
    payment_session: normalizedIntent.payment_session,
    live_booking_details: normalizedIntent.live_booking_details,
    user_info: normalizedIntent.user_info || null,
    quote_snapshot: normalizedIntent.quote_snapshot,
    guest_snapshot: normalizedIntent.guest_snapshot,
    legacy_submit_preview: normalizedIntent.legacy_submit_preview,
  };
}

function buildIntentInternalExecutorRequirements(intentSummary) {
  return buildActionRequiredInputs(intentSummary?.internal_next_actions);
}

function buildIntentMissingRequirements(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const executorHandoff = executionMode === EXECUTOR_HANDOFF_MODE;
  const missing = [];
  const readyChecks = intentSummary?.ready_checks || {};
  const orderCreated = readyChecks.order_created;
  const quoteStillRelevant = !orderCreated;

  if (quoteStillRelevant && !readyChecks.quote_still_valid) {
    missing.push(
      executorHandoff
        ? "Quote snapshot has expired. A fresh quote and intent are required before Bitvoya secure handoff can continue."
        : "Quote has expired and must be refreshed before booking can continue."
    );
    return missing;
  }

  if (intentSummary?.requires_card_attachment && !readyChecks.card_attached) {
    missing.push(
      executorHandoff
        ? "Bitvoya secure checkout still needs a guarantee card before backend submission."
        : "Guarantee card is still missing."
    );
  }

  if (!orderCreated && readyChecks.quote_still_valid && readyChecks.card_attached) {
    missing.push(
      executorHandoff
        ? "Bitvoya internal executor still needs to submit this intent into the legacy backend."
        : "Booking has not been submitted into the legacy backend yet."
    );
  }

  if (
    readyChecks.payment_session_required &&
    orderCreated &&
    !readyChecks.payment_session_created
  ) {
    missing.push(
      executorHandoff
        ? "Bitvoya internal executor still needs to create the downstream payment session."
        : "Immediate-payment session has not been created yet."
    );
  }

  return missing;
}

function buildIntentRequiredInputs(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const readyChecks = intentSummary?.ready_checks || {};

  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    return {
      prepare_booking_quote: [
        "hotel_id",
        "room_id",
        "rate_id",
        "checkin",
        "checkout",
      ],
    };
  }

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    return {
      get_booking_state: ["intent_id"],
    };
  }

  return buildIntentInternalExecutorRequirements(intentSummary);
}

function buildIntentLifecycleState(intentSummary) {
  const readyChecks = intentSummary?.ready_checks || {};

  return {
    quote_state: readyChecks.order_created
      ? "consumed"
      : readyChecks.quote_still_valid
        ? "active"
        : "expired",
    order_state: firstNonEmpty(
      intentSummary?.live_booking_details?.order_info?.booking_status,
      intentSummary?.backend_order?.backend_status,
      readyChecks.order_created ? "submitted" : "not_submitted"
    ),
    payment_state: firstNonEmpty(
      intentSummary?.live_booking_details?.payment_info?.payment_status,
      intentSummary?.payment_session?.status === "created" ? "payment_session_created" : null,
      readyChecks.payment_session_required ? "awaiting_payment_session" : "not_required"
    ),
    guarantee_state: !intentSummary?.requires_card_attachment
      ? "not_required"
      : readyChecks.card_attached
        ? "attached"
        : "missing",
  };
}

function buildIntentPaymentOverview(intentSummary) {
  return {
    payment_method: intentSummary.payment_method,
    payment_requirement: intentSummary.payment_requirement,
    amount_due_now_cny: intentSummary.amount_due_now_cny,
    amount_due_at_hotel_cny: intentSummary.amount_due_at_hotel_cny,
    requires_card_attachment: intentSummary.requires_card_attachment,
    payment_session: intentSummary.payment_session,
  };
}

function buildIntentOrderOverview(intentSummary) {
  return {
    order_id: intentSummary?.backend_order?.order_id || null,
    booking_id: intentSummary?.backend_order?.booking_id || null,
    backend_status: intentSummary?.backend_order?.backend_status || null,
    confirmation_url: intentSummary?.backend_order?.confirmation_url || null,
    submitted_at: intentSummary?.backend_order?.submitted_at || null,
    last_synced_at: intentSummary?.backend_order?.last_synced_at || null,
    live_order_status: intentSummary?.live_booking_details?.order_info?.booking_status || null,
    live_payment_status: intentSummary?.live_booking_details?.payment_info?.payment_status || null,
  };
}

function buildIntentDecisionSummary(tool, intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const executorHandoff = executionMode === EXECUTOR_HANDOFF_MODE;
  const hotelName = intentSummary?.quote_snapshot?.hotel_snapshot?.hotel_name || "selected hotel";
  const rateName = intentSummary?.quote_snapshot?.rate_snapshot?.rate_name || "selected rate";
  const dueNow = intentSummary?.amount_due_now_cny ?? 0;
  const orderId = intentSummary?.backend_order?.order_id || null;
  const sessionId = intentSummary?.payment_session?.session_id || null;
  const orderStatus = firstNonEmpty(
    intentSummary?.live_booking_details?.order_info?.booking_status,
    intentSummary?.backend_order?.backend_status,
    intentSummary?.ready_checks?.order_created ? "submitted" : "not_submitted"
  );
  const paymentStatus = firstNonEmpty(
    intentSummary?.live_booking_details?.payment_info?.payment_status,
    intentSummary?.payment_session?.status === "created" ? "payment_session_created" : null,
    intentSummary?.ready_checks?.payment_session_required ? "awaiting_payment_session" : "not_required"
  );

  if (executorHandoff) {
    if (tool === "create_booking_intent") {
      if (intentSummary.status === "awaiting_card") {
        return `Created booking intent ${intentSummary.intent_id} for ${hotelName} / ${rateName}. Due-now amount is ${dueNow} CNY and the intent is ready for Bitvoya secure checkout handoff.`;
      }

      return `Created booking intent ${intentSummary.intent_id} for ${hotelName} / ${rateName}. Due-now amount is ${dueNow} CNY and downstream completion continues through Bitvoya secure handoff plus internal executor.`;
    }

    if (tool === "attach_booking_card") {
      return `Bitvoya internal executor attached the guarantee card for intent ${intentSummary.intent_id}. Current status is ${intentSummary.status}.`;
    }

    if (tool === "submit_booking_intent") {
      return `Bitvoya internal executor submitted intent ${intentSummary.intent_id}. Order id is ${orderId || "N/A"} and order state is ${orderStatus || "submitted"}.`;
    }

    if (tool === "create_booking_payment_session") {
      if (intentSummary?.payment_requirement === "none") {
        return `No payment session is required for intent ${intentSummary.intent_id} under the current payment path.`;
      }

      return `Bitvoya internal executor created payment session ${sessionId || "created"} for intent ${intentSummary.intent_id}. Current payment state is ${paymentStatus || "pending"}.`;
    }

    if (tool === "refresh_booking_state") {
      return `Bitvoya internal executor refreshed booking state for intent ${intentSummary.intent_id}. Order state is ${orderStatus || "unknown"} and payment state is ${paymentStatus || "unknown"}.`;
    }

    if (tool === "get_booking_state") {
      if (!intentSummary?.ready_checks?.order_created && !intentSummary?.ready_checks?.quote_still_valid) {
        return `Loaded booking state for intent ${intentSummary.intent_id}. The quote snapshot is expired, so Bitvoya secure handoff cannot continue until a new quote and intent are created.`;
      }

      if (!intentSummary?.ready_checks?.order_created) {
        return `Loaded booking state for intent ${intentSummary.intent_id}. Current status is ${intentSummary.status}; the intent is awaiting Bitvoya secure handoff completion.`;
      }

      return `Loaded booking state for intent ${intentSummary.intent_id}. Order state is ${orderStatus || "not_submitted"} and payment state is ${paymentStatus || "not_required"} under Bitvoya internal fulfillment.`;
    }
  }

  if (tool === "create_booking_intent") {
    if (intentSummary.status === "awaiting_card") {
      return `Created booking intent ${intentSummary.intent_id} for ${hotelName} / ${rateName}. Current status is awaiting_card and due-now amount is ${dueNow} CNY.`;
    }

    return `Created booking intent ${intentSummary.intent_id} for ${hotelName} / ${rateName}. Current status is ${intentSummary.status} and due-now amount is ${dueNow} CNY.`;
  }

  if (tool === "attach_booking_card") {
    return `Attached guarantee card to intent ${intentSummary.intent_id}. Current status is ${intentSummary.status} and the flow can continue toward backend submission.`;
  }

  if (tool === "submit_booking_intent") {
    return `Submitted booking intent ${intentSummary.intent_id} into the legacy backend. Order id is ${orderId || "N/A"} and current order state is ${orderStatus || "submitted"}.`;
  }

  if (tool === "create_booking_payment_session") {
    if (intentSummary?.payment_requirement === "none") {
      return `No payment session is required for intent ${intentSummary.intent_id} under the current payment path.`;
    }

    return `Payment session ${sessionId || "created"} is ready for intent ${intentSummary.intent_id}. Current payment state is ${paymentStatus || "pending"}.`;
  }

  if (tool === "refresh_booking_state") {
    return `Refreshed booking state for intent ${intentSummary.intent_id}. Order state is ${orderStatus || "unknown"} and payment state is ${paymentStatus || "unknown"}.`;
  }

  if (tool === "get_booking_state") {
    return `Loaded booking state for intent ${intentSummary.intent_id}. Current status is ${intentSummary.status}, order state is ${orderStatus || "not_submitted"}, and payment state is ${paymentStatus || "not_required"}.`;
  }

  return `Updated booking intent ${intentSummary.intent_id}. Current status is ${intentSummary.status}.`;
}

function buildIntentNextTools(intentSummary, currentTool = null, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const nextTools = [];
  const readyChecks = intentSummary?.ready_checks || {};

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
      nextTools.push(
        buildNextTool(
          "prepare_booking_quote",
          "This intent is blocked by an expired quote snapshot. Regenerate the quote before continuing.",
          ["hotel_id", "room_id", "rate_id", "checkin", "checkout"]
        )
      );
      nextTools.push(
        buildNextTool(
          "get_hotel_rooms",
          "Re-check live rate inventory before regenerating the quote.",
          ["hotel_id", "checkin", "checkout"]
        )
      );
      return nextTools;
    }

    if (currentTool !== "get_booking_state") {
      nextTools.push(
        buildNextTool(
          "get_booking_state",
          "Inspect the current intent state while Bitvoya internal executor owns downstream fulfillment.",
          ["intent_id"]
        )
      );
    }

    return nextTools;
  }

  const internalNextActions = intentSummary?.internal_next_actions || [];

  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    nextTools.push(
      buildNextTool(
        "prepare_booking_quote",
        "This intent is blocked by an expired quote snapshot. Regenerate the quote before continuing.",
        ["hotel_id", "room_id", "rate_id", "checkin", "checkout"]
      )
    );
    nextTools.push(
      buildNextTool(
        "get_hotel_rooms",
        "Re-check live rate inventory before regenerating the quote.",
        ["hotel_id", "checkin", "checkout"]
      )
    );
  } else {
    for (const action of internalNextActions) {
      if (action === currentTool) {
        continue;
      }

      if (action === "attach_booking_card") {
        nextTools.push(
          buildNextTool(
            "attach_booking_card",
            "Guarantee booking cannot proceed until a masked card reference or direct PAN+expiry payload is attached.",
            ["intent_id", "card_reference_id or pan", "expiry"]
          )
        );
        continue;
      }

      if (action === "submit_booking_intent") {
        nextTools.push(
          buildNextTool(
            "submit_booking_intent",
            "Bridge this prepared intent into the existing Bitvoya booking submit flow.",
            ["intent_id"]
          )
        );
        continue;
      }

      if (action === "create_booking_payment_session") {
        nextTools.push(
          buildNextTool(
            "create_booking_payment_session",
            "Create the hosted payment session when the flow requires immediate payment.",
            ["intent_id"]
          )
        );
        continue;
      }

      if (action === "refresh_booking_state") {
        nextTools.push(
          buildNextTool(
            "refresh_booking_state",
            "Refresh order and payment state from the backend after submission or payment initiation.",
            ["intent_id"]
          )
        );
      }
    }
  }

  if (currentTool !== "get_booking_state") {
    nextTools.push(
      buildNextTool(
        "get_booking_state",
        "Inspect current quote/intent/order/payment state without mutating the booking flow.",
        ["intent_id"]
      )
    );
  }

  return nextTools;
}

function buildIntentSelectionHints(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    const hints = [
      "Use intent.ready_checks and execution_boundary.handoff_stage to determine whether Bitvoya internal fulfillment is waiting on quote refresh, card collection, backend submit, or payment creation.",
      "In executor_handoff mode, external agents should stop after create_booking_intent, surface data.secure_handoff to the traveler, and then inspect later state via get_booking_state.",
    ];

    if (intentSummary?.payment_method === "guarantee") {
      hints.push("Guarantee flow still needs card number and expiry, but that collection belongs to Bitvoya-hosted secure checkout rather than the public agent conversation.");
    }

    return hints;
  }

  const hints = [
    "Use intent.ready_checks to determine whether the flow is blocked on card, submission, or payment session creation.",
    "Do not create a payment session before submit_booking_intent returns an order-backed intent.",
  ];

  if (intentSummary?.payment_method === "guarantee") {
    hints.push("Guarantee flow still requires card attachment even when amount_due_now_cny is zero.");
  }

  return hints;
}

function buildIntentWarnings(intentSummary) {
  const warnings = [];
  const readyChecks = intentSummary?.ready_checks || {};

  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    warnings.push("The underlying quote snapshot is expired.");
  }

  if (intentSummary?.backend_order?.live_refresh_error) {
    warnings.push(`Last backend refresh error: ${intentSummary.backend_order.live_refresh_error}`);
  }

  return warnings;
}

function buildIntentResultStatus(intentSummary) {
  const readyChecks = intentSummary?.ready_checks || {};

  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    return "partial";
  }

  if (intentSummary?.backend_order?.live_refresh_error) {
    return "partial";
  }

  return "ok";
}

function buildIntentExecutionBoundary(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const boundary = {
    execution_mode: executionMode,
    sensitive_tools_exposed: executionMode === INTERNAL_EXECUTION_MODE,
    booking_completion_available_in_this_mcp: executionMode === INTERNAL_EXECUTION_MODE,
    public_mcp_scope: ["prepare_booking_quote", "create_booking_intent", "get_booking_state"],
  };

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    const readyChecks = intentSummary?.ready_checks || {};
    boundary.fulfillment_owner = "bitvoya_internal_executor";
    boundary.public_completion_surface = "bitvoya_hosted_secure_checkout";
    boundary.handoff_stage =
      !readyChecks.order_created && !readyChecks.quote_still_valid
        ? "quote_refresh_required"
        : readyChecks.order_created
          ? "internal_execution_in_progress"
          : "awaiting_internal_executor";
    boundary.handoff_ready = readyChecks.order_created ? false : readyChecks.quote_still_valid;
    boundary.internal_executor_next_actions = intentSummary?.internal_next_actions || [];
    boundary.internal_executor_required_inputs = buildIntentInternalExecutorRequirements(intentSummary);
    boundary.internal_executor_scope = [
      "Collect guarantee-card details when required.",
      "Submit prepared booking intents into the legacy Bitvoya booking backend.",
      "Create payment sessions when due-now payment is required.",
      "Refresh backend booking and payment state after submission.",
    ];
  }

  return boundary;
}

function buildIntentExecutionResult(tool, intent, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const intentSummary = buildIntentSummary(intent, { execution_mode: executionMode });
  const quoteSnapshot = intentSummary.quote_snapshot || {};
  const lifecycleState = buildIntentLifecycleState(intentSummary);
  const secureHandoff = buildIntentSecureHandoff(intentSummary, options);
  const executionState = {
    status: intentSummary.status,
    next_actions: intentSummary.next_actions,
    ready_checks: intentSummary.ready_checks,
    lifecycle_state: lifecycleState,
  };

  if (executionMode === EXECUTOR_HANDOFF_MODE) {
    executionState.internal_next_actions = intentSummary.internal_next_actions;
  }

  return buildAgenticToolResult({
    tool,
    status: buildIntentResultStatus(intentSummary),
    intent: tool === "get_booking_state" ? "booking_state_inspection" : "booking_intent_execution",
    summary: buildIntentDecisionSummary(tool, intentSummary, { execution_mode: executionMode }),
    recommended_next_tools: buildIntentNextTools(intentSummary, tool, { execution_mode: executionMode }),
    pricing_notes: [
      "amount_due_now_cny follows the current payment path semantics from the frozen quote snapshot.",
      "For guarantee flows, supplier_total_cny usually remains payable at hotel while service_fee_cny may be due now.",
    ],
    selection_hints: buildIntentSelectionHints(intentSummary, { execution_mode: executionMode }),
    warnings: buildIntentWarnings(intentSummary),
    entity_refs: {
      hotel_ids: [quoteSnapshot?.hotel_snapshot?.hotel_id],
      city_ids: [quoteSnapshot?.hotel_snapshot?.city?.source_city_id],
      room_ids: [quoteSnapshot?.room_snapshot?.room_id],
      rate_ids: [quoteSnapshot?.rate_snapshot?.rate_id],
      tripwiki_hotel_ids: [quoteSnapshot?.hotel_snapshot?.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [quoteSnapshot?.hotel_snapshot?.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      entity: "intent",
      intent: intentSummary,
      payment_overview: buildIntentPaymentOverview(intentSummary),
      order_overview: buildIntentOrderOverview(intentSummary),
      required_inputs: buildIntentRequiredInputs(intentSummary, { execution_mode: executionMode }),
      blocking_requirements: buildIntentMissingRequirements(intentSummary, { execution_mode: executionMode }),
      execution_boundary: buildIntentExecutionBoundary(intentSummary, options),
      execution_state: executionState,
      secure_handoff: secureHandoff,
    },
  });
}

function computeNightCount(checkin, checkout) {
  const checkinMs = Date.parse(`${checkin}T00:00:00Z`);
  const checkoutMs = Date.parse(`${checkout}T00:00:00Z`);
  const diff = Math.round((checkoutMs - checkinMs) / 86400000);
  return diff > 0 ? diff : 1;
}

function encryptCardPayload(config, payload) {
  if (!config.store.cardEncryptionKey) {
    throw new Error("BITVOYA_MCP_CARD_ENCRYPTION_KEY is not configured.");
  }

  const key = crypto.createHash("sha256").update(config.store.cardEncryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: "aes-256-gcm",
    iv_b64: iv.toString("base64"),
    auth_tag_b64: authTag.toString("base64"),
    ciphertext_b64: encrypted.toString("base64"),
  };
}

function decryptCardPayload(config, encryptedPayload) {
  if (!config.store.cardEncryptionKey) {
    throw new Error("BITVOYA_MCP_CARD_ENCRYPTION_KEY is not configured.");
  }

  if (encryptedPayload?.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported card payload encryption algorithm.");
  }

  const key = crypto.createHash("sha256").update(config.store.cardEncryptionKey).digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(encryptedPayload.iv_b64 || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(encryptedPayload.auth_tag_b64 || ""), "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(encryptedPayload.ciphertext_b64 || ""), "base64")),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8"));
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPaymentSessionRequired(intent) {
  return ["full_payment", "service_fee_only"].includes(intent?.payment_requirement);
}

function isCardAttached(intent) {
  return intent?.card_attachment?.status === "attached" && Boolean(intent?.card_attachment?.card_reference_id);
}

function isQuoteExpired(intent) {
  const expiresAtMs = Date.parse(String(intent?.quote_snapshot?.expires_at || ""));
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function resolveIntentOrderId(intent) {
  return normalizeId(
    firstNonEmpty(
      intent?.backend_order?.order_id,
      intent?.live_booking_details?.order_info?.order_id
    )
  );
}

function resolveIntentBookingId(intent) {
  return normalizeId(
    firstNonEmpty(
      intent?.backend_order?.booking_id,
      intent?.live_booking_details?.order_info?.booking_id
    )
  );
}

function hasLiveFinalizedState(intent) {
  const bookingStatus = String(intent?.live_booking_details?.order_info?.booking_status || "").toLowerCase();
  const paymentStatus = String(intent?.live_booking_details?.payment_info?.payment_status || "").toLowerCase();

  return ["confirmed", "paid", "completed"].includes(bookingStatus) || ["paid", "guaranteed"].includes(paymentStatus);
}

function resolveIntentStatus(intent) {
  if (hasLiveFinalizedState(intent)) {
    return "synced";
  }

  if (intent?.payment_session?.status === "created") {
    return "payment_session_created";
  }

  if (resolveIntentOrderId(intent)) {
    return "submitted";
  }

  if (intent?.requires_card_attachment && !isCardAttached(intent)) {
    return "awaiting_card";
  }

  return "ready_to_submit";
}

function resolveNextActions(intent) {
  if (!resolveIntentOrderId(intent)) {
    if (intent?.requires_card_attachment && !isCardAttached(intent)) {
      return ["attach_booking_card"];
    }
    return ["submit_booking_intent"];
  }

  if (isPaymentSessionRequired(intent) && intent?.payment_session?.status !== "created") {
    return ["create_booking_payment_session", "refresh_booking_state"];
  }

  return ["refresh_booking_state"];
}

function normalizeIntentState(intent) {
  const basePaymentSessionStatus = isPaymentSessionRequired(intent) ? "not_created" : "not_required";
  const normalized = {
    ...intent,
    backend_order: {
      submit_status: "not_submitted",
      order_id: null,
      booking_id: null,
      backend_status: null,
      confirmation_url: null,
      submitted_at: null,
      response_snapshot: null,
      last_synced_at: null,
      live_refresh_error: null,
      ...(intent?.backend_order || {}),
    },
    payment_session: {
      status: basePaymentSessionStatus,
      session_id: null,
      session_url: null,
      payment_type: isPaymentSessionRequired(intent) ? intent?.payment_requirement : null,
      currency: intent?.quote_snapshot?.pricing?.currency || "CNY",
      amount: isPaymentSessionRequired(intent) ? intent?.amount_due_now_cny || 0 : 0,
      created_at: null,
      response_snapshot: null,
      ...(intent?.payment_session || {}),
    },
    live_booking_details: intent?.live_booking_details || null,
  };

  normalized.status = resolveIntentStatus(normalized);
  normalized.next_actions = resolveNextActions(normalized);

  return normalized;
}

function buildIntentReadyChecks(intent) {
  const normalized = normalizeIntentState(intent);
  const quoteExpired = isQuoteExpired(normalized);
  const cardAttached = !normalized.requires_card_attachment || isCardAttached(normalized);
  const orderCreated = Boolean(resolveIntentOrderId(normalized));
  const paymentSessionRequired = isPaymentSessionRequired(normalized);

  return {
    quote_still_valid: !quoteExpired,
    card_attached: cardAttached,
    ready_to_submit: !quoteExpired && cardAttached && !orderCreated,
    order_created: orderCreated,
    payment_session_required: paymentSessionRequired,
    payment_session_created: normalized.payment_session?.status === "created",
  };
}

function summarizeBookingDetails(details) {
  if (!details) return null;

  return {
    refreshed_at: new Date().toISOString(),
    order_info: details.order_info || null,
    hotel_info: details.hotel_info
      ? {
          id: details.hotel_info.id,
          name: details.hotel_info.name,
          name_en: details.hotel_info.name_en,
          address: details.hotel_info.address,
          phone: details.hotel_info.phone,
          image: details.hotel_info.image,
        }
      : null,
    room_info: details.room_info
      ? {
          id: details.room_info.id,
          name: details.room_info.name,
          name_en: details.room_info.name_en,
          image: details.room_info.image,
        }
      : null,
    stay_info: details.stay_info || null,
    price_info: details.price_info || null,
    policy_info: details.policy_info || null,
    payment_info: details.payment_info || null,
    special_requests: details.special_requests || null,
    interests: details.interests || [],
    promotions: details.promotions || [],
    guests: Array.isArray(details.guests) ? details.guests : [],
    payments: Array.isArray(details.payments) ? details.payments : [],
    status_history: Array.isArray(details.status_history) ? details.status_history : [],
    cancellation_info: details.cancellation_info || null,
  };
}

function buildLegacyCreditCardInfo(cardBinding, cardPayload) {
  const detected = detectCardType(cardPayload?.pan || "");

  return {
    cardNumber: String(cardPayload?.pan || "").replace(/\D/g, ""),
    cardNumberMasked: cardBinding?.masked_number || maskCardNumber(cardPayload?.pan || ""),
    cardNumberLast4:
      cardBinding?.last4 || String(cardPayload?.card_last4 || cardPayload?.pan || "").replace(/\D/g, "").slice(-4),
    expiry: cardPayload?.expiry || cardBinding?.expiry || null,
    expiryMonth: cardPayload?.expiry_month || cardBinding?.expiry_month || null,
    expiryYear: cardPayload?.expiry_year || cardBinding?.expiry_year || null,
    cardType: cardBinding?.card_type || cardPayload?.card_type || detected.name,
    cardBrand: cardBinding?.card_brand || cardPayload?.card_brand || detected.type,
  };
}

function buildLegacySubmitPayload(intent, config, store) {
  const payload = cloneJson(
    buildLegacySubmitPreview({
      quote: intent?.quote_snapshot,
      intent,
      cardBinding: isCardAttached(intent) ? intent.card_attachment : null,
    })
  );
  if (!payload || typeof payload !== "object") {
    throw new Error("Booking intent does not contain a legacy submit preview.");
  }

  payload.userInfo =
    payload.userInfo && typeof payload.userInfo === "object" && !Array.isArray(payload.userInfo)
      ? payload.userInfo
      : {};

  if (intent.payment_method === "guarantee") {
    if (!isCardAttached(intent)) {
      throw new Error("Guarantee booking requires an attached card before submission.");
    }

    const cardRecord = store.getCard(intent.card_attachment.card_reference_id);
    if (!cardRecord?.encrypted_payload) {
      throw new Error("Attached card reference does not have a retrievable encrypted payload.");
    }

    const cardPayload = decryptCardPayload(config, cardRecord.encrypted_payload);
    const creditCardInfo = buildLegacyCreditCardInfo(intent.card_attachment, cardPayload);

    payload.guestInfo = payload.guestInfo || {};
    payload.guestInfo.creditCardInfo = creditCardInfo;
    payload.creditCardInfo = creditCardInfo;
  } else if (payload?.guestInfo) {
    delete payload.guestInfo.creditCardInfo;
    delete payload.creditCardInfo;
  }

  return payload;
}

function mapPaymentSessionType(intent) {
  if (intent?.payment_requirement === "service_fee_only") {
    return "service_fee_only";
  }

  if (intent?.payment_requirement === "full_payment") {
    return "full_payment";
  }

  return null;
}

export async function prepareBookingQuote(api, db, store, config, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const accountBinding = buildAccountBinding(options);
  const hotelRoomsPayload = await getHotelRooms(api, db, {
    hotel_id: params.hotel_id,
    hotel_name: params.hotel_name || null,
    city_name: params.city_name || null,
    checkin: params.checkin,
    checkout: params.checkout,
    adult_num: params.adult_num,
    child_num: params.child_num || 0,
    room_num: params.room_num || 1,
    room_limit: 50,
    rate_limit_per_room: 50,
  }, options);

  const roomsData = hotelRoomsPayload?.data || hotelRoomsPayload;
  const normalizedRooms = asArray(roomsData?.rooms);
  const identityResolution = roomsData?.identity_resolution || null;
  const liveSelectionCandidates = buildLiveSelectionCandidates(normalizedRooms);
  const topLiveSelection = liveSelectionCandidates[0] || null;
  const topLiveRate = topLiveSelection?.rates?.[0] || null;
  const displayTotalLabel = formatMoneyLabel(topLiveRate?.display_total_cny, "CNY");

  if (normalizedRooms.length === 0) {
    return buildAgenticToolResult({
      tool: "prepare_booking_quote",
      status: hotelRoomsPayload?.status === "not_found" ? "not_found" : "partial",
      intent: "booking_quote_confirmation",
      summary:
        `Could not freeze a booking quote. ${hotelRoomsPayload?.summary || "Live room inventory could not be validated for this selection."}`,
      recommended_next_tools:
        hotelRoomsPayload?.decision_support?.recommended_next_tools || [
          buildNextTool("get_hotel_rooms", "Reload live room inventory before retrying quote creation.", [
            "hotel_id",
            "checkin",
            "checkout",
          ]),
        ],
      warnings: hotelRoomsPayload?.decision_support?.warnings || [],
      pricing_notes: hotelRoomsPayload?.decision_support?.pricing_notes || [
        "display_total_cny is only trustworthy after live room inventory is loaded.",
      ],
      selection_hints: [
        "Do not freeze a quote until get_hotel_rooms returns current bookable room_id and rate_id values.",
        ...(hotelRoomsPayload?.decision_support?.selection_hints || []),
      ],
      entity_refs: hotelRoomsPayload?.entity_refs || {
        hotel_ids: [normalizeId(roomsData?.hotel?.hotel_id) || normalizeId(params.hotel_id)],
      },
      data: {
        found: false,
        quote_preparable: false,
        inventory_status: roomsData?.inventory_status || null,
        hotel: roomsData?.hotel || null,
        stay: roomsData?.stay || {
          checkin: params.checkin,
          checkout: params.checkout,
          adult_num: params.adult_num,
          child_num: params.child_num || 0,
          room_num: params.room_num || 1,
        },
        requested_selection: {
          hotel_id: normalizeId(params.hotel_id),
          hotel_name: firstNonEmpty(params.hotel_name),
          city_name: firstNonEmpty(params.city_name),
          room_id: normalizeId(params.room_id),
          rate_id: normalizeId(params.rate_id),
        },
        identity_resolution: identityResolution,
        upstream_room_lookup: {
          status: hotelRoomsPayload?.status || null,
          summary: hotelRoomsPayload?.summary || null,
        },
      },
    });
  }

  const selectionResolution = resolveRequestedLiveSelection(normalizedRooms, params);
  const selectedRoom = selectionResolution.selected_room;
  const selectedRate = selectionResolution.selected_rate;
  const selectionRecovered = Boolean(
    selectedRoom && selectedRate && selectionResolution.match_strategy !== "room_and_rate_exact"
  );

  if (!selectedRoom || !selectedRate) {
    const mismatchWarnings = [];

    if (identityResolution?.resolution_status === "remapped") {
      mismatchWarnings.push(
        `Requested hotel_id ${params.hotel_id} remapped to canonical live hotel_id ${roomsData?.hotel?.hotel_id}.`
      );
    }

    if (selectionResolution.room_match_status === "not_found") {
      mismatchWarnings.push(
        `Requested room_id ${selectionResolution.requested_room_id || params.room_id} was not found in the current live inventory.`
      );
    } else if (selectionResolution.room_match_status === "ambiguous") {
      mismatchWarnings.push(
        `Requested room_id ${selectionResolution.requested_room_id || params.room_id} matched more than one current live room and cannot be trusted.`
      );
    }

    if (selectionResolution.rate_match_status === "not_found") {
      mismatchWarnings.push(
        `Requested rate_id ${selectionResolution.requested_rate_id || params.rate_id} was not found in the current live inventory.`
      );
    } else if (selectionResolution.rate_match_status === "ambiguous") {
      mismatchWarnings.push(
        `Requested rate_id ${selectionResolution.requested_rate_id || params.rate_id} matched more than one current live rate and cannot be trusted.`
      );
    }

    const presenterLines = [
      "Open with: This hotel is bookable now, but the requested room_id / rate_id are not current live inventory ids.",
      identityResolution?.resolution_status === "remapped"
        ? `Angle: Requested hotel_id ${params.hotel_id} remapped to canonical live hotel_id ${roomsData?.hotel?.hotel_id} before live selection validation.`
        : "Angle: The incoming ids likely came from a frontend page or foreign system rather than current Bitvoya live inventory.",
      topLiveSelection && topLiveRate
        ? `Decision split: Retry quote freeze with current live room_id ${topLiveSelection.room_id} and rate_id ${topLiveRate.rate_id}, or open compare_rates if the traveler still needs tradeoff analysis.`
        : "Decision split: Re-open current live inventory and choose one returned room_id / rate_id pair before retrying.",
      "Ask next: Confirm which current live room/rate should be frozen into a quote.",
    ].filter(Boolean);

    return buildAgenticToolResult({
      tool: "prepare_booking_quote",
      status: "partial",
      intent: "booking_quote_confirmation",
      summary:
        `Live inventory is available for ${roomsData?.hotel?.hotel_name || "this hotel"},` +
        (identityResolution?.resolution_status === "remapped"
          ? ` and canonical live hotel_id recovered as ${roomsData?.hotel?.hotel_id}.`
          : "") +
        ` Requested room_id ${params.room_id} / rate_id ${params.rate_id} do not match current live ids.` +
        (topLiveSelection && topLiveRate
          ? ` Top current bookable option is ${topLiveSelection.room_name} / ${topLiveRate.rate_name}` +
            (displayTotalLabel ? ` at ${displayTotalLabel}.` : ".")
          : " Re-open live inventory and choose a current room/rate pair before retrying."),
      recommended_next_tools: [
        buildNextTool("compare_rates", "Inspect the current live rate tradeoffs before choosing a replacement rate.", [
          "hotel_id",
          "checkin",
          "checkout",
        ]),
        buildNextTool("prepare_booking_quote", "Retry quote freeze with a current live room_id + rate_id pair.", [
          "hotel_id",
          "room_id",
          "rate_id",
          "checkin",
          "checkout",
        ]),
        buildNextTool("get_hotel_rooms", "Re-open live inventory if the traveler needs the full room/rate list again.", [
          "hotel_id",
          "checkin",
          "checkout",
        ]),
      ],
      warnings: mismatchWarnings,
      pricing_notes: [
        "display_total_cny is only meaningful for current live room_id + rate_id pairs.",
        "Do not reuse frontend or foreign-system ids once canonical live inventory has been loaded.",
      ],
      selection_hints: [
        "Retry prepare_booking_quote with one of valid_live_selections[].room_id plus valid_live_selections[].rates[].rate_id.",
        "Use compare_rates if the traveler wants lowest total, strongest perks, or best flexibility before locking.",
      ],
      entity_refs: {
        hotel_ids: [normalizeId(roomsData?.hotel?.hotel_id) || normalizeId(params.hotel_id)],
        city_ids: [normalizeId(roomsData?.hotel?.city?.source_city_id)],
        room_ids: liveSelectionCandidates.map((room) => room.room_id),
        rate_ids: liveSelectionCandidates.flatMap((room) => asArray(room?.rates).map((rate) => rate.rate_id)),
        tripwiki_hotel_ids: [normalizeId(roomsData?.hotel?.grounding_excerpt?.tripwiki_hotel_id)],
        tripwiki_city_ids: [normalizeId(roomsData?.hotel?.city_grounding_excerpt?.tripwiki_city_id)],
      },
      data: {
        found: false,
        quote_preparable: false,
        hotel: roomsData?.hotel || null,
        stay: roomsData?.stay || null,
        identity_resolution: identityResolution,
        requested_selection: {
          hotel_id: normalizeId(params.hotel_id),
          hotel_name: firstNonEmpty(params.hotel_name),
          city_name: firstNonEmpty(params.city_name),
          room_id: selectionResolution.requested_room_id,
          rate_id: selectionResolution.requested_rate_id,
        },
        selection_resolution: {
          requested_room_id: selectionResolution.requested_room_id,
          requested_rate_id: selectionResolution.requested_rate_id,
          match_strategy: selectionResolution.match_strategy,
          room_match_status: selectionResolution.room_match_status,
          rate_match_status: selectionResolution.rate_match_status,
          room_match_candidates: selectionResolution.room_match_candidates,
          rate_match_candidates: selectionResolution.rate_match_candidates,
          matched_room: selectedRoom
            ? {
                room_id: normalizeId(selectedRoom.room_id),
                room_name: firstNonEmpty(selectedRoom.room_name, selectedRoom.room_name_en),
              }
            : null,
          matched_rate: selectedRate
            ? {
                rate_id: normalizeId(selectedRate.rate_id),
                supplier_rate_id: normalizeId(selectedRate.supplier_rate_id),
                rate_name: firstNonEmpty(selectedRate.rate_name, selectedRate.rate_name_en),
              }
            : null,
        },
        selection_guide: roomsData?.selection_guide || null,
        valid_live_selections: liveSelectionCandidates,
        agent_brief: {
          mode: "booking_quote_selection_stale",
          booking_readiness: {
            status: "needs_current_live_ids",
          },
          recommended_opening: "This hotel is bookable now, but the requested room_id / rate_id are not current live inventory ids.",
          recommended_angle:
            identityResolution?.resolution_status === "remapped"
              ? `Requested hotel_id ${params.hotel_id} remapped to canonical live hotel_id ${roomsData?.hotel?.hotel_id} before live selection validation.`
              : "The incoming selection ids likely came from a frontend page or foreign system rather than current Bitvoya live inventory.",
          next_question: "Confirm which current live room/rate should be frozen into a quote.",
          presenter_lines: presenterLines,
        },
      },
    });
  }

  const nowMs = Date.now();
  const expiresAtMs = nowMs + config.store.quoteTtlSeconds * 1000;

  const quoteRecord = store.createQuote({
    account_binding: accountBinding,
    hotel_id: String(roomsData?.hotel?.hotel_id || params.hotel_id),
    room_id: String(selectedRoom.room_id),
    rate_id: String(selectedRate.rate_id),
    created_at_ms: nowMs,
    expires_at_ms: expiresAtMs,
    expires_at: new Date(expiresAtMs).toISOString(),
    source: "bitvoya_api_live_room_inventory",
    stay: {
      checkin: params.checkin,
      checkout: params.checkout,
      nights: computeNightCount(params.checkin, params.checkout),
      adult_num: params.adult_num,
      child_num: params.child_num || 0,
      room_num: params.room_num || 1,
    },
    hotel_snapshot: {
      hotel_id: roomsData.hotel.hotel_id,
      hotel_name: roomsData.hotel.hotel_name,
      hotel_name_en: roomsData.hotel.hotel_name_en,
      city: roomsData.hotel.city,
      brand: roomsData.hotel.brand,
      address: roomsData.hotel.address,
      hero_image_url: roomsData.hotel.media?.hero_image_url || null,
      telephone: roomsData.hotel.contact?.telephone || null,
      membership_benefits: roomsData.hotel.membership_benefits,
      grounding_excerpt: roomsData.hotel.grounding_excerpt,
      city_grounding_excerpt: roomsData.hotel.city_grounding_excerpt,
    },
    room_snapshot: {
      room_id: selectedRoom.room_id,
      room_name: selectedRoom.room_name,
      room_name_en: selectedRoom.room_name_en,
      image_url: selectedRoom.image_urls?.[0] || null,
      amenities: selectedRoom.amenities,
      total_rate_options: selectedRoom.total_rate_options,
      cheapest_display_total_cny: selectedRoom.cheapest_display_total_cny,
    },
    rate_snapshot: {
      rate_id: selectedRate.rate_id,
      supplier_rate_id: selectedRate.supplier_rate_id,
      room_id: selectedRate.room_id,
      rate_name: selectedRate.rate_name,
      rate_name_en: selectedRate.rate_name_en,
      breakfast: selectedRate.breakfast,
    },
    pricing: selectedRate.pricing,
    payment_options: selectedRate.payment_options,
    payment_scenarios: selectedRate.payment_scenarios,
    cancellation_policy: selectedRate.cancellation,
    benefits_snapshot: selectedRate.benefits,
    validation_flags: {
      live_inventory_checked: true,
      hotel_found: true,
      room_found: true,
      rate_found: true,
      canonical_hotel_id_recovered: identityResolution?.resolution_status === "remapped",
      selection_recovered_from_stale_input: selectionRecovered,
      price_semantics_normalized: true,
      quote_expires: true,
    },
    selection_resolution: {
      requested_hotel_id: normalizeId(params.hotel_id),
      requested_room_id: normalizeId(params.room_id),
      requested_rate_id: normalizeId(params.rate_id),
      canonical_hotel_id: normalizeId(roomsData?.hotel?.hotel_id) || normalizeId(params.hotel_id),
      canonical_room_id: normalizeId(selectedRoom.room_id),
      canonical_rate_id: normalizeId(selectedRate.rate_id),
      match_strategy: selectionResolution.match_strategy,
    },
  });

  const quoteSummary = buildQuoteSummary(quoteRecord);
  const prepayPath = buildQuotePaymentPath(quoteRecord, "prepay", { execution_mode: executionMode });
  const guaranteePath = buildQuotePaymentPath(quoteRecord, "guarantee", { execution_mode: executionMode });
  const recommendedNextTools = [
    buildNextTool(
      "create_booking_intent",
      "Create the server-owned booking intent from this frozen quote before any submit or payment step.",
      ["quote_id", "payment_method", "guest_primary", "contact"]
    ),
    buildNextTool(
      "get_hotel_rooms",
      "Refresh live inventory if the quote expires or if the traveler changes room/rate selection.",
      ["hotel_id", "checkin", "checkout"]
    ),
  ];

  if (executionMode === INTERNAL_EXECUTION_MODE && quoteRecord.payment_options?.guarantee_supported) {
    recommendedNextTools.splice(
      1,
      0,
      buildNextTool(
        "attach_booking_card",
        "Guarantee flow will require a card after create_booking_intent and before submit_booking_intent.",
        ["intent_id", "card_reference_id or pan", "expiry"]
      )
    );
  }

  return buildAgenticToolResult({
    tool: "prepare_booking_quote",
    status: "ok",
    intent: "booking_quote_confirmation",
    summary:
      `Prepared quote ${quoteRecord.quote_id} for ${quoteRecord.hotel_snapshot.hotel_name} / ${quoteRecord.room_snapshot.room_name} / ${quoteRecord.rate_snapshot.rate_name}. ` +
      (identityResolution?.resolution_status === "remapped"
        ? `Canonical live hotel_id recovered as ${quoteRecord.hotel_snapshot.hotel_id}. `
        : "") +
      (selectionRecovered
        ? "Recovered the selected room/rate from current live inventory despite stale input ids. "
        : "") +
      `Quote expires at ${quoteRecord.expires_at}. Guest-facing display total is ${formatMoneyLabel(quoteRecord.pricing.display_total_cny, quoteRecord.pricing.currency) || `${quoteRecord.pricing.display_total_cny} ${quoteRecord.pricing.currency}`}.`,
    recommended_next_tools: recommendedNextTools,
    warnings: [
      ...(identityResolution?.resolution_status === "remapped"
        ? [`Requested hotel_id ${params.hotel_id} was normalized to canonical live hotel_id ${quoteRecord.hotel_snapshot.hotel_id}.`]
        : []),
      ...(selectionRecovered
        ? [
            `Requested room_id ${params.room_id} / rate_id ${params.rate_id} were normalized to current live room_id ${quoteRecord.room_snapshot.room_id} / rate_id ${quoteRecord.rate_snapshot.rate_id}.`,
          ]
        : []),
    ],
    pricing_notes: [
      "display_total_cny remains the guest-facing total aligned with current frontend checkout semantics.",
      "supplier_total_cny and service_fee_cny remain explicit so prepay vs guarantee can be reasoned about safely.",
    ],
    selection_hints: [
      "Use payment_paths.prepay or payment_paths.guarantee to choose payment_method for create_booking_intent.",
      "Do not reuse quote_id after expires_at; prepare a fresh quote if the hold window is gone.",
      ...(executionMode === INTERNAL_EXECUTION_MODE
        ? ["Guarantee requires card attachment after intent creation, even when due-now amount is zero."]
        : [
            "In executor_handoff mode, public agents stop at create_booking_intent and then route the traveler through data.secure_handoff on a Bitvoya-hosted secure surface.",
          ]),
    ],
    entity_refs: {
      hotel_ids: [quoteRecord.hotel_snapshot.hotel_id],
      city_ids: [quoteRecord.hotel_snapshot.city?.source_city_id],
      room_ids: [quoteRecord.room_snapshot.room_id],
      rate_ids: [quoteRecord.rate_snapshot.rate_id],
      tripwiki_hotel_ids: [quoteRecord.hotel_snapshot.grounding_excerpt?.tripwiki_hotel_id],
      tripwiki_city_ids: [quoteRecord.hotel_snapshot.city_grounding_excerpt?.tripwiki_city_id],
    },
    data: {
      found: true,
      quote: quoteSummary,
      confirmation_pack: buildQuoteConfirmationPack(quoteRecord),
      payment_paths: {
        prepay: prepayPath,
        guarantee: guaranteePath,
      },
      required_inputs: buildQuoteRequiredInputs(quoteRecord, { execution_mode: executionMode }),
      execution_boundary: buildQuoteExecutionBoundary(quoteRecord, options),
      booking_readiness: {
        quote_valid_now: quoteRecord.expires_at_ms > Date.now(),
        next_required_step: "create_booking_intent",
        next_required_inputs: ["quote_id", "payment_method", "guest_primary", "contact"],
      },
      secure_handoff: buildQuoteSecureHandoff(quoteRecord, options),
    },
  });
}

export async function createBookingIntent(store, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const quote = store.getQuote(params.quote_id);
  const requestAccountBinding = buildAccountBinding(options);

  if (!quote) {
    return buildMissingQuoteRecoveryResult("create_booking_intent", params, { execution_mode: executionMode });
  }

  if (quote.expires_at_ms <= Date.now()) {
    return buildMissingQuoteRecoveryResult("create_booking_intent", params, { execution_mode: executionMode });
  }

  validateQuotePaymentSupport(quote, params.payment_method);

  const guestPrimary = requireGuestPrimary(params.guest_primary);
  const contact = requireContact(params.contact);
  const companions = normalizeCompanions(params.companions);
  const children = normalizeChildren(params.children);
  const specialRequests = Array.isArray(params.special_requests)
    ? params.special_requests.map((item) => String(item).trim()).filter(Boolean)
    : params.special_requests
      ? [String(params.special_requests).trim()].filter(Boolean)
      : [];

  const payment = derivePaymentRequirement(quote, params.payment_method);
  const guestSnapshot = buildGuestSnapshot({
    guestPrimary,
    contact,
    companions,
    children,
    arrivalTime: params.arrival_time,
    specialRequests,
  });
  const accountBinding = quote.account_binding || requestAccountBinding;

  const status = payment.requires_card_attachment ? "awaiting_card" : "ready_to_submit";

  const intentRecord = store.createIntent(normalizeIntentState({
    account_binding: accountBinding,
    quote_id: quote.quote_id,
    status,
    payment_method: params.payment_method,
    payment_requirement: payment.payment_requirement,
    amount_due_now_cny: payment.amount_due_now_cny,
    amount_due_at_hotel_cny: payment.amount_due_at_hotel_cny,
    requires_card_attachment: payment.requires_card_attachment,
    next_actions: payment.next_actions,
    user_info: mergeUserInfoWithAccountBinding(params.user_info, accountBinding),
    quote_snapshot: buildQuoteSummary(quote),
    guest_snapshot: guestSnapshot,
    card_attachment: {
      status: "not_attached",
      card_reference_id: null,
      cardholder_name: null,
      masked_number: null,
      expiry: null,
      expiry_month: null,
      expiry_year: null,
      card_type: null,
      card_brand: null,
      last4: null,
    },
    backend_order: {
      submit_status: "not_submitted",
      order_id: null,
      booking_id: null,
      backend_status: null,
      confirmation_url: null,
      submitted_at: null,
      response_snapshot: null,
      last_synced_at: null,
      live_refresh_error: null,
    },
    payment_session: {
      status: payment.payment_requirement === "none" ? "not_required" : "not_created",
      session_id: null,
      session_url: null,
      payment_type: payment.payment_requirement === "none" ? null : payment.payment_requirement,
      currency: quote?.pricing?.currency || "CNY",
      amount: payment.amount_due_now_cny || 0,
      created_at: null,
      response_snapshot: null,
    },
    live_booking_details: null,
  }));

  const preview = buildLegacySubmitPreview({ quote, intent: intentRecord });
  const updatedIntent = store.updateIntent(intentRecord.intent_id, (current) =>
    normalizeIntentState({
      ...current,
      legacy_submit_preview: preview,
    })
  );

  return buildIntentExecutionResult("create_booking_intent", updatedIntent || intentRecord, options);
}

export async function attachBookingCard(store, config, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const intent = store.getIntent(params.intent_id);
  const requestAccountBinding = buildAccountBinding(options);

  if (!intent) {
    throw new Error("Booking intent not found.");
  }

  if (intent.payment_method !== "guarantee") {
    throw new Error("Card attachment is only required for guarantee intents.");
  }

  let cardReferenceId = params.card_reference_id || null;
  let cardSummary = null;

  if (cardReferenceId) {
    const existing = store.getCard(cardReferenceId);
    if (!existing) {
      throw new Error("card_reference_id was not found.");
    }

     const intentAccountId = normalizeId(intent?.account_binding?.account_id);
     const existingAccountId = normalizeId(existing?.account_binding?.account_id);
     if (intentAccountId && !existingAccountId) {
      throw new Error("card_reference_id is not bound to a Bitvoya account.");
    }

    if (intentAccountId && existingAccountId && intentAccountId !== existingAccountId) {
      throw new Error("card_reference_id belongs to a different Bitvoya account.");
    }

    cardSummary = existing.summary;
  } else {
    const pan = String(params.pan || "").replace(/\D/g, "");
    if (!luhnCheck(pan)) {
      throw new Error("Card number failed validation.");
    }

    const expiry = normalizeExpiry(params.expiry);
    const detectedCardType = detectCardType(pan);
    const summary = {
      cardholder_name: compactText(params.cardholder_name || "", 120) || null,
      masked_number: maskCardNumber(pan),
      last4: pan.slice(-4),
      expiry: expiry.expiry,
      expiry_month: expiry.expiry_month,
      expiry_year: expiry.expiry_year,
      card_type: params.card_type || detectedCardType.name,
      card_brand: params.card_brand || detectedCardType.type,
    };

    const encryptedPayload = encryptCardPayload(config, {
      pan,
      expiry: expiry.expiry,
      expiry_month: expiry.expiry_month,
      expiry_year: expiry.expiry_year,
      cardholder_name: params.cardholder_name || null,
      card_type: summary.card_type,
      card_brand: summary.card_brand,
      card_last4: summary.last4,
    });

    const cardRecord = store.createCard({
      account_binding: intent.account_binding || requestAccountBinding,
      intent_id: intent.intent_id,
      storage_mode: "encrypted_runtime_store",
      encrypted_payload: encryptedPayload,
      summary,
    });

    cardReferenceId = cardRecord.card_reference_id;
    cardSummary = summary;
  }

  const nextStatus = "ready_to_submit";
  const updatedIntent = store.updateIntent(intent.intent_id, (current) => {
    const next = normalizeIntentState({
      ...current,
      status: nextStatus,
      card_attachment: {
        status: "attached",
        card_reference_id: cardReferenceId,
        cardholder_name: cardSummary.cardholder_name || null,
        masked_number: cardSummary.masked_number,
        expiry: cardSummary.expiry,
        expiry_month: cardSummary.expiry_month,
        expiry_year: cardSummary.expiry_year,
        card_type: cardSummary.card_type,
        card_brand: cardSummary.card_brand,
        last4: cardSummary.last4,
      },
    });

    next.legacy_submit_preview = buildLegacySubmitPreview({
      quote: current.quote_snapshot,
      intent: next,
      cardBinding: next.card_attachment,
    });

    return next;
  });

  return buildIntentExecutionResult("attach_booking_card", updatedIntent, options);
}

export async function submitBookingIntent(api, store, config, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const intent = store.getIntent(params.intent_id);

  if (!intent) {
    throw new Error("Booking intent not found.");
  }

  const currentIntent = normalizeIntentState(intent);
  if (resolveIntentOrderId(currentIntent)) {
    return buildIntentExecutionResult("submit_booking_intent", currentIntent, options);
  }

  if (isQuoteExpired(currentIntent)) {
    throw new Error("Quote snapshot has expired. Please prepare a fresh booking quote and intent.");
  }

  if (currentIntent.requires_card_attachment && !isCardAttached(currentIntent)) {
    throw new Error("Guarantee booking requires card attachment before submission.");
  }

  const legacyPayload = buildLegacySubmitPayload(currentIntent, config, store);
  const submitResponse = await api.submitBooking(legacyPayload, {
    requestPrincipal: options.request_principal || null,
  });
  const submittedAt = new Date().toISOString();
  const orderId = normalizeId(firstNonEmpty(submitResponse?.order_id, submitResponse?.id));
  const bookingId = normalizeId(submitResponse?.booking_id);

  if (!orderId) {
    throw new Error("Bitvoya booking submit response did not contain an order_id.");
  }

  let liveBookingDetails = null;
  let liveRefreshError = null;

  try {
    liveBookingDetails = summarizeBookingDetails(await api.getBookingDetails(orderId, {
      requestPrincipal: options.request_principal || null,
    }));
  } catch (error) {
    liveRefreshError = error?.message || String(error);
  }

  const updatedIntent = store.updateIntent(currentIntent.intent_id, (stored) =>
    normalizeIntentState({
      ...stored,
      backend_order: {
        ...(stored?.backend_order || {}),
        submit_status: "submitted",
        order_id: orderId,
        booking_id: bookingId,
        backend_status: firstNonEmpty(submitResponse?.status, liveBookingDetails?.order_info?.booking_status),
        confirmation_url: submitResponse?.confirmation_url || null,
        submitted_at: submittedAt,
        response_snapshot: submitResponse,
        last_synced_at: liveBookingDetails ? liveBookingDetails.refreshed_at : null,
        live_refresh_error: liveRefreshError,
      },
      live_booking_details: liveBookingDetails || stored?.live_booking_details || null,
    })
  );

  return buildIntentExecutionResult("submit_booking_intent", updatedIntent || currentIntent, options);
}

export async function createBookingPaymentSession(api, store, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const intent = store.getIntent(params.intent_id);

  if (!intent) {
    throw new Error("Booking intent not found.");
  }

  const currentIntent = normalizeIntentState(intent);
  const paymentType = mapPaymentSessionType(currentIntent);
  if (!paymentType) {
    return buildIntentExecutionResult("create_booking_payment_session", currentIntent, options);
  }

  if (currentIntent.payment_session?.status === "created") {
    return buildIntentExecutionResult("create_booking_payment_session", currentIntent, options);
  }

  const orderId = resolveIntentOrderId(currentIntent);
  if (!orderId) {
    throw new Error("Booking intent must be submitted before a payment session can be created.");
  }

  const sessionResponse = await api.createStripeSession({
    orderId,
    paymentType,
    successUrl: params.success_url,
    cancelUrl: params.cancel_url,
  }, {
    requestPrincipal: options.request_principal || null,
  });

  const updatedIntent = store.updateIntent(currentIntent.intent_id, (stored) =>
    normalizeIntentState({
      ...stored,
      payment_session: {
        ...(stored?.payment_session || {}),
        status: "created",
        session_id: normalizeId(firstNonEmpty(sessionResponse?.session_id, sessionResponse?.id)),
        session_url: sessionResponse?.session_url || sessionResponse?.url || null,
        payment_type: sessionResponse?.payment_type || paymentType,
        currency: sessionResponse?.currency || stored?.payment_session?.currency || "CNY",
        amount: firstNonEmpty(
          asNullableNumber(sessionResponse?.service_fee_amount),
          stored?.payment_session?.amount,
          stored?.amount_due_now_cny,
          0
        ),
        created_at: new Date().toISOString(),
        response_snapshot: sessionResponse,
      },
    })
  );

  return buildIntentExecutionResult("create_booking_payment_session", updatedIntent || currentIntent, options);
}

export async function refreshBookingState(api, store, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const intent = store.getIntent(params.intent_id);

  if (!intent) {
    throw new Error("Booking intent not found.");
  }

  const currentIntent = normalizeIntentState(intent);
  const orderId = resolveIntentOrderId(currentIntent);

  if (!orderId) {
    throw new Error("Booking intent has not been submitted yet.");
  }

  const liveDetails = summarizeBookingDetails(await api.getBookingDetails(orderId, {
    requestPrincipal: options.request_principal || null,
  }));
  const updatedIntent = store.updateIntent(currentIntent.intent_id, (stored) =>
    normalizeIntentState({
      ...stored,
      backend_order: {
        ...(stored?.backend_order || {}),
        submit_status: "submitted",
        order_id: orderId,
        booking_id: resolveIntentBookingId({
          ...stored,
          live_booking_details: liveDetails,
        }),
        backend_status: firstNonEmpty(
          liveDetails?.order_info?.booking_status,
          liveDetails?.payment_info?.payment_status,
          stored?.backend_order?.backend_status
        ),
        last_synced_at: liveDetails?.refreshed_at || new Date().toISOString(),
        live_refresh_error: null,
      },
      live_booking_details: liveDetails,
    })
  );

  return buildIntentExecutionResult("refresh_booking_state", updatedIntent || currentIntent, options);
}

export async function getBookingState(store, params, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  if (params.intent_id) {
    const intent = store.getIntent(params.intent_id);
    if (!intent) {
      return buildAgenticToolResult({
        tool: "get_booking_state",
        status: "not_found",
        intent: "booking_state_inspection",
        summary: "Booking intent not found.",
        recommended_next_tools: [
          buildNextTool("prepare_booking_quote", "Start again from a fresh quote if the old intent can no longer be found.", [
            "hotel_id",
            "room_id",
            "rate_id",
            "checkin",
            "checkout",
          ]),
        ],
        data: {
          found: false,
          entity: "intent",
          reason: "Booking intent not found.",
        },
      });
    }

    return buildIntentExecutionResult("get_booking_state", intent, options);
  }

  if (params.quote_id) {
    const quote = store.getQuote(params.quote_id);
    if (!quote) {
      return buildMissingQuoteRecoveryResult("get_booking_state", params, options);
    }

    return buildQuoteStateResult("get_booking_state", quote, options);
  }

  throw new Error("One of intent_id or quote_id is required.");
}
