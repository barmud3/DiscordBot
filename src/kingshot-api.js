const API_BASE = "https://kingshot.net/api/player-info";

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

  const url = `${API_BASE}?playerId=${encodeURIComponent(playerId)}`;
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

module.exports = { fetchPlayerInfo };
