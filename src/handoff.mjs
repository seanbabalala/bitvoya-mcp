import crypto from "node:crypto";

const EXECUTOR_HANDOFF_MODE = "executor_handoff";
const INTERNAL_EXECUTION_MODE = "internal_execution";
const HANDOFF_MODE_DISABLED = "disabled";
const HANDOFF_MODE_PLANNED = "planned";
const HANDOFF_MODE_SIGNED_URL = "signed_url";

function normalizeExecutionMode(options = {}) {
  const mode =
    typeof options === "string"
      ? options
      : options?.execution_mode;

  return mode === EXECUTOR_HANDOFF_MODE ? EXECUTOR_HANDOFF_MODE : INTERNAL_EXECUTION_MODE;
}

function normalizeHandoffMode(value) {
  const mode = String(value || HANDOFF_MODE_PLANNED).trim().toLowerCase();
  return [HANDOFF_MODE_DISABLED, HANDOFF_MODE_PLANNED, HANDOFF_MODE_SIGNED_URL].includes(mode)
    ? mode
    : HANDOFF_MODE_PLANNED;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nowUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function toIsoFromUnix(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

function asNonEmptyString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizePreferredLanguage(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    ["zh-tw", "zh_tw", "zh-hk", "zh_hk", "zh-mo", "zh_mo", "tw", "hk"].includes(normalized)
  ) {
    return "zh-TW";
  }

  if (
    ["zh", "zh-cn", "zh_cn", "cn", "chinese"].includes(normalized) ||
    normalized.startsWith("zh")
  ) {
    return "zh-CN";
  }

  if (
    ["ja", "ja-jp", "ja_jp", "jp", "japanese"].includes(normalized) ||
    normalized.startsWith("ja")
  ) {
    return "ja";
  }

  if (
    ["ko", "ko-kr", "ko_kr", "kr", "korean"].includes(normalized) ||
    normalized.startsWith("ko")
  ) {
    return "ko";
  }

  return "en";
}

function buildSignedDisplayPreferences(intentSummary) {
  const userInfo =
    intentSummary?.user_info && typeof intentSummary.user_info === "object"
      ? intentSummary.user_info
      : {};

  const preferredLanguage = normalizePreferredLanguage(
    userInfo.preferred_language ??
      userInfo.preferredLanguage ??
      userInfo.lang ??
      userInfo.language ??
      userInfo.locale ??
      null
  );

  return preferredLanguage ? { preferred_language: preferredLanguage } : {};
}

function buildSignedUserBinding(intentSummary) {
  const userInfo =
    intentSummary?.user_info && typeof intentSummary.user_info === "object"
      ? intentSummary.user_info
      : {};

  const userId = asNonEmptyString(
    userInfo.user_id ?? userInfo.id ?? userInfo.userId ?? null
  );
  const accountId = asNonEmptyString(
    userInfo.account_id ??
      userInfo.accountId ??
      userInfo.user_uuid ??
      userInfo.uuid ??
      userId
  );
  const email = asNonEmptyString(userInfo.email ?? null);

  return {
    ...(userId ? { user_id: userId } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(email ? { email } : {}),
  };
}

function buildSignedLaunchUrl(claims, handoffConfig = {}) {
  const mode = normalizeHandoffMode(handoffConfig.mode);

  if (mode === HANDOFF_MODE_DISABLED) {
    return {
      launch_url: null,
      launch_url_status: "disabled",
      launch_url_available: false,
      launch_url_expires_at: null,
    };
  }

  if (mode === HANDOFF_MODE_PLANNED) {
    return {
      launch_url: null,
      launch_url_status: "planned_no_url",
      launch_url_available: false,
      launch_url_expires_at: null,
    };
  }

  const baseUrl = String(handoffConfig.baseUrl || "").trim();
  if (!baseUrl) {
    return {
      launch_url: null,
      launch_url_status: "missing_base_url",
      launch_url_available: false,
      launch_url_expires_at: null,
    };
  }

  const signingSecret = String(handoffConfig.signingSecret || "").trim();
  if (!signingSecret) {
    return {
      launch_url: null,
      launch_url_status: "missing_signing_secret",
      launch_url_available: false,
      launch_url_expires_at: null,
    };
  }

  const issuedAt = nowUnixSeconds();
  const ttlSeconds = Number.isFinite(handoffConfig.tokenTtlSeconds)
    ? Math.max(300, handoffConfig.tokenTtlSeconds)
    : 1800;
  const expiresAt = issuedAt + ttlSeconds;
  const payload = base64urlJson({
    ...claims,
    iat: issuedAt,
    exp: expiresAt,
    nonce: crypto.randomUUID(),
  });
  const signature = crypto.createHmac("sha256", signingSecret).update(payload).digest("base64url");
  const separator = baseUrl.includes("?") ? "&" : "?";

  return {
    launch_url: `${baseUrl}${separator}handoff=${payload}.${signature}`,
    launch_url_status: "signed_url_ready",
    launch_url_available: true,
    launch_url_expires_at: toIsoFromUnix(expiresAt),
  };
}

function buildQuotePaymentMethodPreview(quote, paymentMethod) {
  const prepay = paymentMethod === "prepay";
  const supported = prepay
    ? Boolean(quote?.payment_options?.prepay_supported)
    : Boolean(quote?.payment_options?.guarantee_supported);

  if (!supported) {
    return {
      supported: false,
      traveler_action_required: false,
      secure_surface: "bitvoya_hosted_secure_checkout",
      expected_traveler_steps: [],
      amount_due_now_cny: null,
      amount_due_at_hotel_cny: null,
    };
  }

  return {
    supported: true,
    traveler_action_required: true,
    secure_surface: "bitvoya_hosted_secure_checkout",
    expected_traveler_steps: prepay
      ? [
          "Open Bitvoya-hosted secure checkout after create_booking_intent.",
          "Review guest and trip details inside Bitvoya-hosted checkout.",
          "Complete hosted payment if due-now payment is required.",
        ]
      : [
          "Open Bitvoya-hosted secure checkout after create_booking_intent.",
          "Enter guarantee card number and expiry only on the Bitvoya-hosted page.",
          "Complete any hosted service-fee payment if required.",
        ],
    amount_due_now_cny: prepay
      ? quote?.pricing?.display_total_cny ?? null
      : quote?.pricing?.service_fee_cny ?? 0,
    amount_due_at_hotel_cny: prepay ? 0 : quote?.pricing?.supplier_total_cny ?? null,
    sensitive_input_owner: "bitvoya_hosted_secure_checkout",
  };
}

function buildIntentSecureState(intentSummary) {
  const readyChecks = intentSummary?.ready_checks || {};

  if (!readyChecks.order_created && !readyChecks.quote_still_valid) {
    return {
      state: "quote_refresh_required",
      traveler_action_required: false,
      current_owner: "agent_or_traveler",
    };
  }

  if (!readyChecks.order_created) {
    return {
      state: "ready_for_secure_checkout",
      traveler_action_required: true,
      current_owner: "traveler_secure_checkout",
    };
  }

  if (readyChecks.payment_session_required && readyChecks.payment_session_created) {
    return {
      state: "payment_pending",
      traveler_action_required: true,
      current_owner: "traveler_secure_checkout",
    };
  }

  return {
    state: "internal_processing",
    traveler_action_required: false,
    current_owner: "bitvoya_internal_executor",
  };
}

export function buildQuoteSecureHandoff(quote, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const handoffMode = normalizeHandoffMode(options?.config?.handoff?.mode);
  const quoteValidNow = Number(quote?.expires_at_ms || 0) > Date.now();

  if (executionMode !== EXECUTOR_HANDOFF_MODE) {
    return {
      model: "bitvoya_hosted_secure_checkout",
      mode: handoffMode,
      enabled: false,
      state: "not_required_in_internal_execution",
      launch_surface: "bitvoya_hosted_web",
      launch_url: null,
      launch_url_status: "not_required",
      launch_url_available: false,
      launch_url_expires_at: null,
      traveler_action_required: false,
      launch_after_tool: null,
      post_handoff_status_tool: "get_booking_state",
      by_payment_method: {
        prepay: buildQuotePaymentMethodPreview(quote, "prepay"),
        guarantee: buildQuotePaymentMethodPreview(quote, "guarantee"),
      },
      security_rules: [
        "Trusted internal-execution mode may continue booking inside MCP without redirecting the traveler into hosted secure checkout.",
      ],
    };
  }

  return {
    model: "bitvoya_hosted_secure_checkout",
    mode: handoffMode,
    enabled: handoffMode !== HANDOFF_MODE_DISABLED,
    state: quoteValidNow ? "available_after_intent_creation" : "quote_refresh_required",
    launch_surface: "bitvoya_hosted_web",
    launch_url: null,
    launch_url_status: quoteValidNow ? "intent_required" : "quote_expired",
    launch_url_available: false,
    launch_url_expires_at: null,
    traveler_action_required: false,
    launch_after_tool: "create_booking_intent",
    post_handoff_status_tool: "get_booking_state",
    by_payment_method: {
      prepay: buildQuotePaymentMethodPreview(quote, "prepay"),
      guarantee: buildQuotePaymentMethodPreview(quote, "guarantee"),
    },
    security_rules: [
      "Do not collect raw PAN or expiry in the public agent conversation.",
      "After create_booking_intent, the traveler should continue on a Bitvoya-hosted secure surface when payment or guarantee-card input is needed.",
      "The public agent should return to get_booking_state for status inspection after handoff.",
    ],
  };
}

export function buildIntentSecureHandoff(intentSummary, options = {}) {
  const executionMode = normalizeExecutionMode(options);
  const handoffMode = normalizeHandoffMode(options?.config?.handoff?.mode);

  if (executionMode !== EXECUTOR_HANDOFF_MODE) {
    return {
      model: "bitvoya_hosted_secure_checkout",
      mode: handoffMode,
      enabled: false,
      state: "not_required_in_internal_execution",
      current_owner: "bitvoya_internal_executor",
      traveler_action_required: false,
      launch_surface: "bitvoya_hosted_web",
      launch_url: null,
      launch_url_status: "not_required",
      launch_url_available: false,
      launch_url_expires_at: null,
      card_input_owner:
        intentSummary?.payment_method === "guarantee"
          ? "bitvoya_internal_executor"
          : "not_required",
      payment_input_owner:
        Number(intentSummary?.amount_due_now_cny || 0) > 0
          ? "bitvoya_internal_executor"
          : "not_required",
      traveler_steps: [],
      internal_steps_after_traveler: intentSummary?.internal_next_actions || [],
      post_handoff_status_tool: "get_booking_state",
      security_rules: [
        "Internal execution mode keeps sensitive continuation inside Bitvoya-controlled services rather than a public hosted handoff surface.",
      ],
    };
  }

  const secureState = buildIntentSecureState(intentSummary);
  const launch =
    secureState.state === "quote_refresh_required"
      ? {
          launch_url: null,
          launch_url_status: "quote_refresh_required",
          launch_url_available: false,
          launch_url_expires_at: null,
        }
      : buildSignedLaunchUrl(
          {
            version: 1,
            type: "booking_intent_handoff",
            intent_id: intentSummary?.intent_id || null,
            quote_id: intentSummary?.quote_id || null,
            payment_method: intentSummary?.payment_method || null,
            amount_due_now_cny: intentSummary?.amount_due_now_cny ?? null,
            amount_due_at_hotel_cny: intentSummary?.amount_due_at_hotel_cny ?? null,
            requires_card_attachment: Boolean(intentSummary?.requires_card_attachment),
            intent_status: intentSummary?.status || null,
            ...buildSignedUserBinding(intentSummary),
            ...buildSignedDisplayPreferences(intentSummary),
          },
          options?.config?.handoff
        );

  const paymentMethod = intentSummary?.payment_method;
  const dueNow = Number(intentSummary?.amount_due_now_cny || 0);
  const travelerSteps =
    secureState.state === "quote_refresh_required"
      ? [
          "Refresh the quote and recreate the booking intent before attempting secure handoff again.",
        ]
      : paymentMethod === "guarantee"
        ? [
            "Open Bitvoya-hosted secure checkout.",
            "Review traveler and stay details on the Bitvoya-hosted page.",
            "Enter guarantee card number and expiry only on the Bitvoya-hosted page.",
            ...(dueNow > 0
              ? ["Complete hosted service-fee payment if Bitvoya checkout requires it."]
              : []),
          ]
        : [
            "Open Bitvoya-hosted secure checkout.",
            "Review traveler and stay details on the Bitvoya-hosted page.",
            ...(dueNow > 0
              ? ["Complete hosted payment on the Bitvoya-controlled payment surface."]
              : ["Allow Bitvoya internal executor to continue without extra payment input."]),
          ];

  return {
    model: "bitvoya_hosted_secure_checkout",
    mode: handoffMode,
    enabled: handoffMode !== HANDOFF_MODE_DISABLED,
    state: secureState.state,
    current_owner: secureState.current_owner,
    traveler_action_required: secureState.traveler_action_required,
    launch_surface: "bitvoya_hosted_web",
    launch_url: launch.launch_url,
    launch_url_status: launch.launch_url_status,
    launch_url_available: launch.launch_url_available,
    launch_url_expires_at: launch.launch_url_expires_at,
    card_input_owner:
      paymentMethod === "guarantee"
        ? "bitvoya_hosted_secure_checkout"
        : "not_required",
    payment_input_owner: dueNow > 0 ? "bitvoya_hosted_secure_checkout" : "not_required",
    traveler_steps: travelerSteps,
    internal_steps_after_traveler: intentSummary?.internal_next_actions || [],
    post_handoff_status_tool: "get_booking_state",
    security_rules: [
      "Do not ask the traveler to paste raw card number or expiry into the agent conversation.",
      "Hosted payment or guarantee capture should occur only on Bitvoya-controlled surfaces.",
      "The agent should use get_booking_state after handoff instead of attempting direct booking execution.",
    ],
  };
}
