import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function defaultState() {
  return {
    quotes: {},
    intents: {},
    cards: {},
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeParseStore(raw) {
  if (!raw) return defaultState();

  try {
    const parsed = JSON.parse(raw);
    return {
      quotes: parsed?.quotes || {},
      intents: parsed?.intents || {},
      cards: parsed?.cards || {},
    };
  } catch {
    return defaultState();
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

export function createRuntimeStore(config) {
  const storePath = config.store.path;

  function readState() {
    if (!fs.existsSync(storePath)) {
      return defaultState();
    }

    return safeParseStore(fs.readFileSync(storePath, "utf8"));
  }

  function saveState(state) {
    writeJsonAtomic(storePath, state);
  }

  function cleanupExpired(state) {
    const nowMs = Date.now();

    for (const [quoteId, quote] of Object.entries(state.quotes || {})) {
      if ((quote?.expires_at_ms || 0) <= nowMs) {
        delete state.quotes[quoteId];
      }
    }

    for (const [intentId, intent] of Object.entries(state.intents || {})) {
      const updatedAtMs = intent?.updated_at_ms || intent?.created_at_ms || 0;
      if (updatedAtMs + config.store.intentRetentionSeconds * 1000 <= nowMs) {
        delete state.intents[intentId];
      }
    }

    for (const [cardId, card] of Object.entries(state.cards || {})) {
      const updatedAtMs = card?.updated_at_ms || card?.created_at_ms || 0;
      if (updatedAtMs + config.store.intentRetentionSeconds * 1000 <= nowMs) {
        delete state.cards[cardId];
      }
    }

    return state;
  }

  function mutate(mutator) {
    const state = cleanupExpired(readState());
    const result = mutator(state);
    saveState(state);
    return result;
  }

  function createId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return {
    getStorePath() {
      return storePath;
    },

    getSnapshotCounts() {
      const state = cleanupExpired(readState());
      return {
        quotes: Object.keys(state.quotes).length,
        intents: Object.keys(state.intents).length,
        cards: Object.keys(state.cards).length,
      };
    },

    createQuote(record) {
      return mutate((state) => {
        const quoteId = record.quote_id || createId("quote");
        const createdAtMs = record.created_at_ms || Date.now();
        state.quotes[quoteId] = {
          ...record,
          quote_id: quoteId,
          created_at_ms: createdAtMs,
          created_at: record.created_at || new Date(createdAtMs).toISOString(),
          updated_at_ms: Date.now(),
          updated_at: nowIso(),
        };
        return state.quotes[quoteId];
      });
    },

    getQuote(quoteId) {
      const state = cleanupExpired(readState());
      return state.quotes[quoteId] || null;
    },

    createIntent(record) {
      return mutate((state) => {
        const intentId = record.intent_id || createId("intent");
        const createdAtMs = record.created_at_ms || Date.now();
        state.intents[intentId] = {
          ...record,
          intent_id: intentId,
          created_at_ms: createdAtMs,
          created_at: record.created_at || new Date(createdAtMs).toISOString(),
          updated_at_ms: Date.now(),
          updated_at: nowIso(),
        };
        return state.intents[intentId];
      });
    },

    getIntent(intentId) {
      const state = cleanupExpired(readState());
      return state.intents[intentId] || null;
    },

    updateIntent(intentId, updater) {
      return mutate((state) => {
        const current = state.intents[intentId];
        if (!current) {
          return null;
        }

        const next = updater(current);
        if (!next) {
          return null;
        }

        state.intents[intentId] = {
          ...next,
          updated_at_ms: Date.now(),
          updated_at: nowIso(),
        };
        return state.intents[intentId];
      });
    },

    createCard(record) {
      return mutate((state) => {
        const cardId = record.card_reference_id || createId("card");
        const createdAtMs = record.created_at_ms || Date.now();
        state.cards[cardId] = {
          ...record,
          card_reference_id: cardId,
          created_at_ms: createdAtMs,
          created_at: record.created_at || new Date(createdAtMs).toISOString(),
          updated_at_ms: Date.now(),
          updated_at: nowIso(),
        };
        return state.cards[cardId];
      });
    },

    getCard(cardReferenceId) {
      const state = cleanupExpired(readState());
      return state.cards[cardReferenceId] || null;
    },
  };
}
