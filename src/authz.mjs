function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .flatMap((value) =>
          typeof value === "string" ? value.split(/[,\s]+/) : [value]
        )
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

export const MCP_SCOPE = {
  INVENTORY_READ: "inventory.read",
  GROUNDING_READ: "grounding.read",
  QUOTE_WRITE: "quote.write",
  INTENT_WRITE: "intent.write",
  BOOKING_STATE_READ: "booking.state.read",
  CARD_CAPTURE_CREATE: "card.capture.create",
  BOOKING_EXECUTE: "booking.execute",
  TOKEN_MANAGE: "token.manage",
};

export const DEFAULT_SCOPE_BUNDLES = {
  public_partner_agent: [
    MCP_SCOPE.INVENTORY_READ,
    MCP_SCOPE.GROUNDING_READ,
    MCP_SCOPE.QUOTE_WRITE,
    MCP_SCOPE.INTENT_WRITE,
    MCP_SCOPE.BOOKING_STATE_READ,
  ],
  bitvoya_managed_private_agent: [
    MCP_SCOPE.INVENTORY_READ,
    MCP_SCOPE.GROUNDING_READ,
    MCP_SCOPE.QUOTE_WRITE,
    MCP_SCOPE.INTENT_WRITE,
    MCP_SCOPE.BOOKING_STATE_READ,
    MCP_SCOPE.CARD_CAPTURE_CREATE,
  ],
  internal_service: [
    MCP_SCOPE.INVENTORY_READ,
    MCP_SCOPE.GROUNDING_READ,
    MCP_SCOPE.QUOTE_WRITE,
    MCP_SCOPE.INTENT_WRITE,
    MCP_SCOPE.BOOKING_STATE_READ,
    MCP_SCOPE.CARD_CAPTURE_CREATE,
    MCP_SCOPE.BOOKING_EXECUTE,
    MCP_SCOPE.TOKEN_MANAGE,
  ],
};

export const AGENT_KEY_PROFILES = {
  user_created_standard: {
    profile_id: "user_created_standard",
    actor_type: "partner_agent",
    management: "user_created",
    shared_account_scope: true,
    description:
      "Default Bitvoya user-created agent key. Multiple keys may exist per user, but all keys map back to the same Bitvoya account data and booking history.",
    scopes: DEFAULT_SCOPE_BUNDLES.public_partner_agent,
  },
  bitvoya_managed_private: {
    profile_id: "bitvoya_managed_private",
    actor_type: "bitvoya_managed_agent",
    management: "bitvoya_managed",
    shared_account_scope: true,
    description:
      "Bitvoya-managed private agent key. Shares the same underlying account view, but may receive additional fulfillment-adjacent scopes inside Bitvoya-controlled infrastructure.",
    scopes: DEFAULT_SCOPE_BUNDLES.bitvoya_managed_private_agent,
  },
  internal_service: {
    profile_id: "internal_service",
    actor_type: "internal_service",
    management: "internal_only",
    shared_account_scope: true,
    description:
      "Internal Bitvoya service credential for executor and operational paths. This profile is never user-created.",
    scopes: DEFAULT_SCOPE_BUNDLES.internal_service,
  },
};

const DEFAULT_ALLOWED_ACTOR_TYPES = [
  "human_user",
  "partner_agent",
  "bitvoya_managed_agent",
  "internal_service",
];

const INTERNAL_EXECUTOR_ACTOR_TYPES = [
  "bitvoya_managed_agent",
  "internal_service",
];

const TOOL_AUTHORIZATION_POLICIES = {
  start_travel_planning: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  start_hotel_search: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  create_booking: {
    required_scopes: [
      MCP_SCOPE.INVENTORY_READ,
      MCP_SCOPE.GROUNDING_READ,
      MCP_SCOPE.QUOTE_WRITE,
      MCP_SCOPE.INTENT_WRITE,
    ],
    exposure: "public",
  },
  search_cities: {
    required_scopes: [MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  search_destination_suggestions: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  search_cities_live: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  list_hot_cities: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  get_city_grounding: {
    required_scopes: [MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  search_hotels: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_detail: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_profile: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_rooms: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  compare_hotels: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  compare_rates: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_media: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  get_nearby_hotels: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_collections: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  list_seo_collections: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  get_seo_collection: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  get_featured_hotels: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ],
    exposure: "public",
  },
  search_hotels_grounding: {
    required_scopes: [MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  get_hotel_grounding: {
    required_scopes: [MCP_SCOPE.GROUNDING_READ],
    exposure: "public",
  },
  prepare_booking_quote: {
    required_scopes: [MCP_SCOPE.INVENTORY_READ, MCP_SCOPE.GROUNDING_READ, MCP_SCOPE.QUOTE_WRITE],
    exposure: "public",
  },
  create_booking_intent: {
    required_scopes: [MCP_SCOPE.INTENT_WRITE],
    exposure: "public",
  },
  get_booking_state: {
    required_scopes: [MCP_SCOPE.BOOKING_STATE_READ],
    exposure: "public",
  },
  attach_booking_card: {
    required_scopes: [MCP_SCOPE.BOOKING_EXECUTE],
    exposure: "internal",
    allowed_actor_types: INTERNAL_EXECUTOR_ACTOR_TYPES,
  },
  submit_booking_intent: {
    required_scopes: [MCP_SCOPE.BOOKING_EXECUTE],
    exposure: "internal",
    allowed_actor_types: INTERNAL_EXECUTOR_ACTOR_TYPES,
  },
  create_booking_payment_session: {
    required_scopes: [MCP_SCOPE.BOOKING_EXECUTE],
    exposure: "internal",
    allowed_actor_types: INTERNAL_EXECUTOR_ACTOR_TYPES,
  },
  refresh_booking_state: {
    required_scopes: [MCP_SCOPE.BOOKING_EXECUTE],
    exposure: "internal",
    allowed_actor_types: INTERNAL_EXECUTOR_ACTOR_TYPES,
  },
};

export function normalizeScopeList(scopes) {
  return uniqueStrings(scopes);
}

export function getDefaultScopeBundles() {
  return Object.fromEntries(
    Object.entries(DEFAULT_SCOPE_BUNDLES).map(([key, value]) => [key, [...value]])
  );
}

export function getAgentKeyProfile(profileId) {
  const profile = AGENT_KEY_PROFILES[String(profileId || "").trim()];
  if (!profile) {
    return null;
  }

  return {
    ...profile,
    scopes: [...profile.scopes],
  };
}

export function listAgentKeyProfiles() {
  return Object.keys(AGENT_KEY_PROFILES).map((profileId) => getAgentKeyProfile(profileId));
}

function setEquals(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value) => right.includes(value));
}

export function inferAgentKeyProfile(principal = {}) {
  const actorType = String(principal.actor_type || "partner_agent");
  const scopes = normalizeScopeList(principal.scopes);
  const profiles = listAgentKeyProfiles().filter((profile) => profile.actor_type === actorType);

  if (profiles.length === 0) {
    return null;
  }

  const exactMatch = profiles.find((profile) => setEquals(profile.scopes, scopes));
  if (exactMatch) {
    return {
      ...exactMatch,
      match_type: "exact",
      extra_scopes: [],
      missing_profile_scopes: [],
    };
  }

  const supersetMatch = profiles.find((profile) =>
    profile.scopes.every((scope) => scopes.includes(scope))
  );
  if (supersetMatch) {
    return {
      ...supersetMatch,
      match_type: "superset",
      extra_scopes: scopes.filter((scope) => !supersetMatch.scopes.includes(scope)),
      missing_profile_scopes: [],
    };
  }

  const closestProfile = profiles
    .map((profile) => ({
      profile,
      overlapCount: profile.scopes.filter((scope) => scopes.includes(scope)).length,
    }))
    .sort((left, right) => right.overlapCount - left.overlapCount)[0]?.profile;

  if (!closestProfile) {
    return null;
  }

  return {
    ...closestProfile,
    match_type: "partial",
    extra_scopes: scopes.filter((scope) => !closestProfile.scopes.includes(scope)),
    missing_profile_scopes: closestProfile.scopes.filter((scope) => !scopes.includes(scope)),
  };
}

export function getToolAuthorizationPolicy(toolName) {
  const policy = TOOL_AUTHORIZATION_POLICIES[String(toolName || "").trim()];
  if (!policy) {
    return null;
  }

  return {
    tool: toolName,
    required_scopes: [...policy.required_scopes],
    exposure: policy.exposure,
    allowed_actor_types: [...(policy.allowed_actor_types || DEFAULT_ALLOWED_ACTOR_TYPES)],
  };
}

export function listToolAuthorizationPolicies(options = {}) {
  const bookingExecutionMode = options.bookingExecutionMode || "executor_handoff";
  const includeHidden = Boolean(options.includeHidden);

  return Object.keys(TOOL_AUTHORIZATION_POLICIES)
    .map((tool) => {
      const policy = getToolAuthorizationPolicy(tool);
      const exposed =
        policy.exposure === "public" || bookingExecutionMode === "internal_execution";

      if (!includeHidden && !exposed) {
        return null;
      }

      return {
        ...policy,
        exposed,
      };
    })
    .filter(Boolean);
}

export function evaluateToolAuthorization(principal, toolName, options = {}) {
  const bookingExecutionMode = options.bookingExecutionMode || "executor_handoff";
  const resourceAccountId =
    options.resourceAccountId === null || options.resourceAccountId === undefined
      ? null
      : String(options.resourceAccountId);
  const policy = getToolAuthorizationPolicy(toolName);

  if (!policy) {
    return {
      allowed: false,
      reason: "unknown_tool",
      tool: toolName,
      missing_scopes: [],
    };
  }

  if (policy.exposure === "internal" && bookingExecutionMode !== "internal_execution") {
    return {
      allowed: false,
      reason: "tool_not_exposed_in_current_mode",
      tool: toolName,
      policy,
      missing_scopes: [],
    };
  }

  if (!principal || typeof principal !== "object") {
    return {
      allowed: false,
      reason: "missing_principal",
      tool: toolName,
      policy,
      missing_scopes: [...policy.required_scopes],
    };
  }

  const normalizedPrincipal = {
    account_id:
      principal.account_id === null || principal.account_id === undefined
        ? null
        : String(principal.account_id),
    actor_type: String(principal.actor_type || "partner_agent"),
    account_status: String(principal.account_status || "active"),
    scopes: normalizeScopeList(principal.scopes),
  };

  if (normalizedPrincipal.account_status !== "active") {
    return {
      allowed: false,
      reason: "inactive_account",
      tool: toolName,
      policy,
      missing_scopes: [],
      principal: normalizedPrincipal,
    };
  }

  if (
    resourceAccountId &&
    normalizedPrincipal.account_id &&
    normalizedPrincipal.account_id !== resourceAccountId
  ) {
    return {
      allowed: false,
      reason: "account_mismatch",
      tool: toolName,
      policy,
      missing_scopes: [],
      principal: normalizedPrincipal,
    };
  }

  if (!policy.allowed_actor_types.includes(normalizedPrincipal.actor_type)) {
    return {
      allowed: false,
      reason: "actor_not_allowed",
      tool: toolName,
      policy,
      missing_scopes: [],
      principal: normalizedPrincipal,
    };
  }

  const missingScopes = policy.required_scopes.filter(
    (scope) => !normalizedPrincipal.scopes.includes(scope)
  );

  if (missingScopes.length > 0) {
    return {
      allowed: false,
      reason: "missing_scopes",
      tool: toolName,
      policy,
      missing_scopes: missingScopes,
      principal: normalizedPrincipal,
    };
  }

  return {
    allowed: true,
    reason: "authorized",
    tool: toolName,
    policy,
    missing_scopes: [],
    principal: normalizedPrincipal,
  };
}
