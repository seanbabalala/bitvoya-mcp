import crypto from "node:crypto";

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
    closed: false,
    closeReason: null,
  };
}

export function createHttpSessionRuntimeManager(options = {}) {
  const sessions = new Map();
  const pending = new Map();
  const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs || 0));
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

  async function closeRecord(record, reason = "unknown") {
    if (!record || record.closed) {
      return false;
    }

    record.closed = true;
    record.closeReason = String(reason || "unknown");

    if (record.sessionId) {
      sessions.delete(String(record.sessionId));
    }

    if (record.pendingId) {
      pending.delete(String(record.pendingId));
    }

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
      if (!record.closed && now - record.lastSeenAt >= idleTimeoutMs) {
        idleRecords.push(record);
      }
    }

    for (const record of pending.values()) {
      if (!record.closed && now - record.lastSeenAt >= idleTimeoutMs) {
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
    return {
      sessionCount: sessions.size,
      pendingCount: pending.size,
      sessions: Array.from(sessions.values()).map((record) => ({
        runtimeId: record.runtimeId,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        principalSummary: record.principalSummary,
      })),
      pending: Array.from(pending.values()).map((record) => ({
        runtimeId: record.runtimeId,
        pendingId: record.pendingId,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        principalSummary: record.principalSummary,
      })),
    };
  }

  return {
    createPendingSessionRuntime,
    bindPendingSessionRuntime,
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
