import * as z from "zod/v4";

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = compactObject(entry);
      if (nested && Object.keys(nested).length > 0) {
        next[key] = nested;
      }
      continue;
    }
    if (entry === null || entry === undefined || entry === "") continue;
    next[key] = entry;
  }
  return next;
}

export const agenticToolOutputSchema = z
  .object({
    object: z.literal("tool_result"),
    tool: z.string().min(1),
    status: z.enum(["ok", "not_found", "partial"]),
    intent: z.string().min(1),
    summary: z.string().min(1),
    decision_support: z
      .object({
        recommended_next_tools: z
          .array(
            z.object({
              tool: z.string().min(1),
              reason: z.string().min(1),
              required_inputs: z.array(z.string().min(1)).optional(),
            })
          )
          .optional(),
        warnings: z.array(z.string().min(1)).optional(),
        pricing_notes: z.array(z.string().min(1)).optional(),
        selection_hints: z.array(z.string().min(1)).optional(),
        assumptions: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    entity_refs: z
      .object({
        city_ids: z.array(z.string().min(1)).optional(),
        hotel_ids: z.array(z.string().min(1)).optional(),
        room_ids: z.array(z.string().min(1)).optional(),
        rate_ids: z.array(z.string().min(1)).optional(),
        tripwiki_city_ids: z.array(z.string().min(1)).optional(),
        tripwiki_hotel_ids: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    data: z.object({}).loose(),
  })
  .loose();

export function buildNextTool(tool, reason, requiredInputs = []) {
  const payload = {
    tool,
    reason,
  };

  const cleanedInputs = uniqueStrings(requiredInputs);
  if (cleanedInputs.length > 0) {
    payload.required_inputs = cleanedInputs;
  }

  return payload;
}

export function buildEntityRefs(refs = {}) {
  return compactObject({
    city_ids: uniqueStrings(refs.city_ids),
    hotel_ids: uniqueStrings(refs.hotel_ids),
    room_ids: uniqueStrings(refs.room_ids),
    rate_ids: uniqueStrings(refs.rate_ids),
    tripwiki_city_ids: uniqueStrings(refs.tripwiki_city_ids),
    tripwiki_hotel_ids: uniqueStrings(refs.tripwiki_hotel_ids),
  });
}

export function buildAgenticToolResult({
  tool,
  status = "ok",
  intent,
  summary,
  data,
  recommended_next_tools = [],
  warnings = [],
  pricing_notes = [],
  selection_hints = [],
  assumptions = [],
  entity_refs = {},
}) {
  return compactObject({
    object: "tool_result",
    tool,
    status,
    intent,
    summary,
    decision_support: {
      recommended_next_tools,
      warnings,
      pricing_notes,
      selection_hints,
      assumptions,
    },
    entity_refs: buildEntityRefs(entity_refs),
    data,
  });
}

export function buildToolTextResult(payload) {
  if (!payload || typeof payload !== "object") {
    const text = JSON.stringify(payload, null, 2);
    return {
      content: [{ type: "text", text }],
      structuredContent: payload,
    };
  }

  const lines = [];

  if (payload.summary) {
    lines.push(payload.summary);
  }

  const agentBrief = payload?.data?.agent_brief;
  const agentLines = Array.isArray(agentBrief?.presenter_lines)
    ? agentBrief.presenter_lines.map((line) => String(line || "").trim()).filter(Boolean)
    : [];
  if (agentLines.length > 0) {
    lines.push("Agent read:");
    lines.push(...agentLines.map((line) => `- ${line}`));
  }

  const nextTools = Array.isArray(payload?.decision_support?.recommended_next_tools)
    ? payload.decision_support.recommended_next_tools
    : [];
  if (nextTools.length > 0) {
    lines.push("Recommended next tools:");
    lines.push(
      ...nextTools.map((item) => {
        const requiredInputs = Array.isArray(item?.required_inputs)
          ? item.required_inputs.map((value) => String(value || "").trim()).filter(Boolean)
          : [];
        const inputsText =
          requiredInputs.length > 0 ? ` Inputs: ${requiredInputs.join(", ")}.` : "";
        return `- ${item.tool}: ${String(item?.reason || "").trim()}${inputsText}`;
      })
    );
  }

  const warnings = Array.isArray(payload?.decision_support?.warnings)
    ? payload.decision_support.warnings
    : [];
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.join(" | ")}`);
  }

  const selectionHints = Array.isArray(payload?.decision_support?.selection_hints)
    ? payload.decision_support.selection_hints.map((hint) => String(hint || "").trim()).filter(Boolean)
    : [];
  if (selectionHints.length > 0) {
    lines.push("Routing hints:");
    lines.push(...selectionHints.map((hint) => `- ${hint}`));
  }

  const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";

  return {
    content: [
      {
        type: "text",
        text: `${prefix}${JSON.stringify(payload, null, 2)}`,
      },
    ],
    structuredContent: payload,
  };
}
