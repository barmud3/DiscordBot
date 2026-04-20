const API_BASE = "https://kingshot.net/api";
const PLAYER_INFO_URL = `${API_BASE}/player-info`;

/** Kingshot.net limits this endpoint to 6 requests per minute. */
class MinuteRateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.timestamps = [];
  }

  /** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
  tryAcquire() {
    const now = Date.now();
    const windowMs = 60_000;
    this.timestamps = this.timestamps.filter((t) => now - t < windowMs);
    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      return { ok: false, retryAfterMs: windowMs - (now - oldest) };
    }
    this.timestamps.push(now);
    return { ok: true };
  }
}

const limiter = new MinuteRateLimiter(6);

const idCache = new Map();
const CACHE_TTL_MS = 60_000;
const kvkCache = new Map();
const KVK_CACHE_TTL_MS = 60_000;

/**
 * @param {string} playerId
 * @returns {Promise<{ ok: true, data: object } | { ok: false, code: string, message: string, retryAfterMs?: number }>}
 */
async function fetchPlayerInfo(playerId) {
  const cached = idCache.get(playerId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  const gate = limiter.tryAcquire();
  if (!gate.ok) {
    return {
      ok: false,
      code: "LOCAL_RATE_LIMIT",
      message: "Too many lookups. Please wait a moment and try again.",
      retryAfterMs: gate.retryAfterMs,
    };
  }

  const url = `${PLAYER_INFO_URL}?playerId=${encodeURIComponent(playerId)}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return {
      ok: false,
      code: "NETWORK",
      message: "Could not reach Kingshot API. Check your connection or try again later.",
    };
  }

  if (res.status === 429) {
    return {
      ok: false,
      code: "API_RATE_LIMIT",
      message: "Kingshot API rate limit reached. Try again in a minute.",
    };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: "Unexpected response from Kingshot API.",
    };
  }

  if (res.status === 400 || body.status !== "success" || !body.data) {
    const msg =
      typeof body.message === "string"
        ? body.message
        : "Invalid player ID or player not found.";
    return { ok: false, code: "BAD_REQUEST", message: msg };
  }

  idCache.set(playerId, { at: Date.now(), data: body.data });
  return { ok: true, data: body.data };
}

/**
 * @param {{season?: number, page?: number, limit?: number, kingdomA?: number, kingdomB?: number, status?: string}} options
 * @returns {Promise<{ ok: true, data: any[], pagination: any } | { ok: false, code: string, message: string }>}
 */
async function fetchKvkMatches(options = {}) {
  const season = Number.isFinite(Number(options.season)) ? Number(options.season) : undefined;
  const page = Number.isFinite(Number(options.page)) ? Math.max(1, Number(options.page)) : 1;
  const limit = Number.isFinite(Number(options.limit))
    ? Math.min(50, Math.max(1, Number(options.limit)))
    : 20;
  const kingdomA = Number.isFinite(Number(options.kingdomA))
    ? Number(options.kingdomA)
    : undefined;
  const kingdomB = Number.isFinite(Number(options.kingdomB))
    ? Number(options.kingdomB)
    : undefined;
  const status =
    typeof options.status === "string" && options.status.trim()
      ? options.status.trim()
      : undefined;

  const query = new URLSearchParams();
  query.set("page", String(page));
  query.set("limit", String(limit));
  if (season !== undefined) {
    query.set("season", String(season));
  }
  if (kingdomA !== undefined) {
    query.set("kingdom_a", String(kingdomA));
  }
  if (kingdomB !== undefined) {
    query.set("kingdom_b", String(kingdomB));
  }
  if (status !== undefined) {
    query.set("status", status);
  }

  const cacheKey = query.toString();
  const cached = kvkCache.get(cacheKey);
  if (cached && Date.now() - cached.at < KVK_CACHE_TTL_MS) {
    return { ok: true, data: cached.data, pagination: cached.pagination };
  }

  const url = `${API_BASE}/kvk/matches?${query.toString()}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (_) {
    return {
      ok: false,
      code: "NETWORK",
      message: "Could not reach Kingshot API. Check your connection or try again later.",
    };
  }

  if (res.status === 429) {
    return {
      ok: false,
      code: "API_RATE_LIMIT",
      message: "Kingshot API rate limit reached. Try again in a minute.",
    };
  }

  let body;
  try {
    body = await res.json();
  } catch (_) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: "Unexpected response from Kingshot API.",
    };
  }

  if (!res.ok || body.status !== "success" || !Array.isArray(body.data)) {
    const msg =
      typeof body?.message === "string"
        ? body.message
        : "Could not retrieve KvK matches from Kingshot API.";
    return { ok: false, code: "BAD_REQUEST", message: msg };
  }

  kvkCache.set(cacheKey, {
    at: Date.now(),
    data: body.data,
    pagination: body.pagination ?? null,
  });

  return { ok: true, data: body.data, pagination: body.pagination ?? null };
}

/**
 * @param {{kingdomId: number}} options
 * @returns {Promise<{ ok: true, data: any[] } | { ok: false, code: string, message: string }>}
 */
async function fetchKvkMatchesForKingdom(options) {
  const kingdomId = Number(options?.kingdomId);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    return { ok: false, code: "BAD_REQUEST", message: "Invalid kingdom ID." };
  }

  const limit = 50;
  const maxPages = 200;
  const collectedA = [];
  const collectedB = [];

  let pageA = 1;
  let hasMoreA = true;
  while (hasMoreA && pageA <= maxPages) {
    const res = await fetchKvkMatches({ page: pageA, limit, kingdomA: kingdomId });
    if (!res.ok) return res;
    collectedA.push(...res.data);
    hasMoreA = Boolean(res.pagination?.hasMore);
    pageA += 1;
  }

  let pageB = 1;
  let hasMoreB = true;
  while (hasMoreB && pageB <= maxPages) {
    const res = await fetchKvkMatches({ page: pageB, limit, kingdomB: kingdomId });
    if (!res.ok) return res;
    collectedB.push(...res.data);
    hasMoreB = Boolean(res.pagination?.hasMore);
    pageB += 1;
  }

  const merged = [...collectedA, ...collectedB];
  const deduped = Array.from(
    new Map(merged.map((m) => [String(m.kvk_id ?? `${m.season_id}-${m.kingdom_a}-${m.kingdom_b}`), m])).values()
  ).sort((x, y) => Number(y.kvk_id ?? 0) - Number(x.kvk_id ?? 0));

  return { ok: true, data: deduped };
}

module.exports = { fetchPlayerInfo, fetchKvkMatches, fetchKvkMatchesForKingdom };
