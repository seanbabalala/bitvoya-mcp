import crypto from "node:crypto";

const DEFAULT_CLOSED_SESSION_RETENTION_MS = 60 * 60 * 1000;

async function safeCloseRuntime(record) {
  try {
    if (record?.transport) {
      await record.transport.close();
    }
  } catch {}

  try {
    if (record?.server) {
      await record.server.close();
    }
  } catch {}
}

function buildRuntimeRecord(runtime, options = {}) {
  const now = Date.now();

  return {
    runtimeId: String(options.runtimeId || crypto.randomUUID()),
    pendingId: options.pendingId || null,
    sessionId: options.sessionId || null,
    server: runtime.server,
    transport: runtime.transport,
    principalSummary: options.principalSummary || null,
    createdAt: now,
    lastSeenAt: now,
    requestCount: 0,
    activeRequestCount: 0,
    lastRequestStartedAt: null,
    lastRequestCompletedAt: null,
    closed: false,
    closeReason: null,
    closedAt: null,
  };
}

export function createHttpSessionRuntimeManager(options = {}) {
  const sessions = new Map();
  const pending = new Map();
  const closedSessions = new Map();
  const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs || 0));
  const closedSessionRetentionMs = Math.max(
    1_000,
    Number(options.closedSessionRetentionMs || DEFAULT_CLOSED_SESSION_RETENTION_MS)
  );
  const sweepIntervalMs = Math.max(
    10,
    Number(options.sweepIntervalMs || Math.min(idleTimeoutMs || 60_000, 60_000))
  );
  const onRuntimeClosed =
    typeof options.onRuntimeClosed === "function" ? options.onRuntimeClosed : null;

  let closingAll = false;
  let sweepTimer = null;

  function startSweepTimer() {
    if (!idleTimeoutMs || sweepTimer) {
      return;
    }

    sweepTimer = setInterval(() => {
      void closeIdleSessionRuntimes();
    }, sweepIntervalMs);

    if (typeof sweepTimer.unref === "function") {
      sweepTimer.unref();
    }
  }

  function stopSweepTimer() {
    if (!sweepTimer) {
      return;
    }

    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  function touchRecord(record) {
    if (!record || record.closed) {
      return null;
    }

    record.lastSeenAt = Date.now();
    return record;
  }

  function pruneClosedSessions() {
    const cutoff = Date.now() - closedSessionRetentionMs;

    for (const [sessionId, summary] of closedSessions.entries()) {
      if ((summary?.closedAt || 0) < cutoff) {
        closedSessions.delete(sessionId);
      }
    }
  }

  function rememberClosedSession(record) {
    if (!record?.sessionId) {
      return;
    }

    pruneClosedSessions();
    closedSessions.set(String(record.sessionId), {
      runtimeId: record.runtimeId,
      sessionId: record.sessionId,
      principalSummary: record.principalSummary || null,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      requestCount: record.requestCount || 0,
      activeRequestCount: record.activeRequestCount || 0,
      lastRequestStartedAt: record.lastRequestStartedAt || null,
      lastRequestCompletedAt: record.lastRequestCompletedAt || null,
      closeReason: record.closeReason || "unknown",
      closedAt: record.closedAt || Date.now(),
    });
  }

  function getSessionRuntime(sessionId) {
    if (!sessionId) {
      return null;
    }

    return touchRecord(sessions.get(String(sessionId)) || null);
  }

  function getPendingSessionRuntime(pendingId) {
    if (!pendingId) {
      return null;
    }

    return touchRecord(pending.get(String(pendingId)) || null);
  }

  function setPrincipalSummary(record, principalSummary) {
    if (!record || !principalSummary) {
      return record;
    }

    if (!record.principalSummary) {
      record.principalSummary = principalSummary;
    }

    return record;
  }

  function beginRuntimeRequest(record) {
    if (!record || record.closed) {
      return null;
    }

    const now = Date.now();
    record.lastSeenAt = now;
    record.lastRequestStartedAt = now;
    record.requestCount += 1;
    record.activeRequestCount += 1;
    return record;
  }

  function endRuntimeRequest(record) {
    if (!record || record.closed) {
      return null;
    }

    const now = Date.now();
    record.lastSeenAt = now;
    record.lastRequestCompletedAt = now;
    record.activeRequestCount = Math.max(0, Number(record.activeRequestCount || 0) - 1);
    return record;
  }

  async function closeRecord(record, reason = "unknown") {
    if (!record || record.closed) {
      return false;
    }

    record.closed = true;
    record.closeReason = String(reason || "unknown");
    record.closedAt = Date.now();

    if (record.sessionId) {
      sessions.delete(String(record.sessionId));
    }

    if (record.pendingId) {
      pending.delete(String(record.pendingId));
    }

    rememberClosedSession(record);
    await safeCloseRuntime(record);

    if (onRuntimeClosed) {
      await Promise.resolve(onRuntimeClosed(record, record.closeReason));
    }

    return true;
  }

  async function createPendingSessionRuntime(principalSummary, createRuntime) {
    const pendingId = crypto.randomUUID();
    const runtime = await createRuntime({ pendingId });
    const record = buildRuntimeRecord(runtime, {
      pendingId,
      principalSummary,
    });

    pending.set(pendingId, record);
    startSweepTimer();

    return {
      pendingId,
      record,
      created: true,
    };
  }

  function bindPendingSessionRuntime(pendingId, sessionId) {
    if (!pendingId || !sessionId) {
      return null;
    }

    const record = pending.get(String(pendingId));
    if (!record || record.closed) {
      return null;
    }

    pending.delete(String(pendingId));
    record.pendingId = null;
    record.sessionId = String(sessionId);
    touchRecord(record);
    sessions.set(record.sessionId, record);
    startSweepTimer();

    return record;
  }

  async function getOrCreateSessionRuntime(sessionId, principalSummary, createRuntime) {
    const existing = getSessionRuntime(sessionId);
    if (existing) {
      setPrincipalSummary(existing, principalSummary);
      return {
        record: existing,
        created: false,
      };
    }

    const runtime = await createRuntime({ sessionId });
    const record = buildRuntimeRecord(runtime, {
      sessionId: String(sessionId),
      principalSummary,
    });

    sessions.set(record.sessionId, record);
    startSweepTimer();

    return {
      record,
      created: true,
    };
  }

  function touchSessionRuntime(sessionId) {
    return getSessionRuntime(sessionId);
  }

  async function closeSessionRuntime(sessionId, reason = "explicit_close") {
    const record = sessions.get(String(sessionId)) || null;
    return closeRecord(record, reason);
  }

  async function closePendingSessionRuntime(pendingId, reason = "pending_close") {
    const record = pending.get(String(pendingId)) || null;
    return closeRecord(record, reason);
  }

  async function closeIdleSessionRuntimes() {
    if (!idleTimeoutMs || closingAll) {
      return [];
    }

    const now = Date.now();
    const idleRecords = [];

    for (const record of sessions.values()) {
      if (
        !record.closed &&
        Number(record.activeRequestCount || 0) === 0 &&
        now - record.lastSeenAt >= idleTimeoutMs
      ) {
        idleRecords.push(record);
      }
    }

    for (const record of pending.values()) {
      if (
        !record.closed &&
        Number(record.activeRequestCount || 0) === 0 &&
        now - record.lastSeenAt >= idleTimeoutMs
      ) {
        idleRecords.push(record);
      }
    }

    for (const record of idleRecords) {
      await closeRecord(record, "idle_timeout");
    }

    return idleRecords.map((record) => ({
      runtimeId: record.runtimeId,
      sessionId: record.sessionId,
      pendingId: record.pendingId,
    }));
  }

  async function closeAllSessionRuntimes(reason = "shutdown") {
    if (closingAll) {
      return;
    }

    closingAll = true;
    stopSweepTimer();

    const records = [...sessions.values(), ...pending.values()];
    for (const record of records) {
      await closeRecord(record, reason);
    }

    closingAll = false;
  }

  function getSnapshot() {
    pruneClosedSessions();

    return {
      sessionCount: sessions.size,
      pendingCount: pending.size,
      sessions: Array.from(sessions.values()).map((record) => ({
        runtimeId: record.runtimeId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        requestCount: record.requestCount,
        activeRequestCount: record.activeRequestCount,
        lastRequestStartedAt: record.lastRequestStartedAt,
        lastRequestCompletedAt: record.lastRequestCompletedAt,
        principalSummary: record.principalSummary,
      })),
      pending: Array.from(pending.values()).map((record) => ({
        runtimeId: record.runtimeId,
        pendingId: record.pendingId,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        requestCount: record.requestCount,
        activeRequestCount: record.activeRequestCount,
        lastRequestStartedAt: record.lastRequestStartedAt,
        lastRequestCompletedAt: record.lastRequestCompletedAt,
        principalSummary: record.principalSummary,
      })),
      closedSessions: Array.from(closedSessions.values()),
    };
  }

  function getClosedSessionSummary(sessionId) {
    if (!sessionId) {
      return null;
    }

    pruneClosedSessions();
    return closedSessions.get(String(sessionId)) || null;
  }

  return {
    beginRuntimeRequest,
    createPendingSessionRuntime,
    bindPendingSessionRuntime,
    endRuntimeRequest,
    getClosedSessionSummary,
    getOrCreateSessionRuntime,
    getPendingSessionRuntime,
    getSessionRuntime,
    touchSessionRuntime,
    closePendingSessionRuntime,
    closeSessionRuntime,
    closeAllSessionRuntimes,
    closeIdleSessionRuntimes,
    getSnapshot,
  };
}
