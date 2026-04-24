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
const kingdomCache = new Map();
const KINGDOM_CACHE_TTL_MS = 60_000;

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

/**
 * @param {number} kingdomId
 * @returns {Promise<{ ok: true, data: any } | { ok: false, code: string, message: string }>}
 */
async function fetchKingdomTrackerById(kingdomId) {
  const id = Number(kingdomId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, code: "BAD_REQUEST", message: "Invalid kingdom ID." };
  }

  const cacheKey = String(id);
  const cached = kingdomCache.get(cacheKey);
  if (cached && Date.now() - cached.at < KINGDOM_CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  const url = `${API_BASE}/kingdom-tracker?kingdomId=${encodeURIComponent(String(id))}`;
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

  if (!res.ok || body.status !== "success") {
    const msg =
      typeof body?.message === "string"
        ? body.message
        : "Could not retrieve kingdom tracker data.";
    return { ok: false, code: "BAD_REQUEST", message: msg };
  }

  const servers = Array.isArray(body?.data?.servers) ? body.data.servers : [];
  const kingdom = servers.find((s) => Number(s.kingdomId) === id) ?? null;
  if (!kingdom) {
    return { ok: false, code: "NOT_FOUND", message: `No tracker data found for kingdom #${id}.` };
  }

  kingdomCache.set(cacheKey, { at: Date.now(), data: kingdom });
  return { ok: true, data: kingdom };
}

/**
 * @param {{
 *   satin: number,
 *   gildedThreads: number,
 *   artisansVision: number,
 *   hat: string,
 *   chain: string,
 *   shirt: string,
 *   pants: string,
 *   ring: string,
 *   baton: string
 * }} input
 * @returns {Promise<{ ok: true, data: any } | { ok: false, code: string, message: string }>}
 */
async function fetchGovernorGearOptimization(input) {
  const endpoint = "https://api.kingshotoptimizer.com/governor-gear";

  const toStep = (level) => {
    const levels = [
      "Green",
      "Green⭐",
      "Blue",
      "Blue⭐",
      "Blue⭐⭐",
      "Blue⭐⭐⭐",
      "Purple",
      "Purple⭐",
      "Purple⭐⭐",
      "Purple⭐⭐⭐",
      "Purple T1",
      "Purple T1⭐",
      "Purple T1⭐⭐",
      "Purple T1⭐⭐⭐",
      "Gold",
      "Gold⭐",
      "Gold⭐⭐",
      "Gold⭐⭐⭐",
      "Gold T1",
      "Gold T1⭐",
      "Gold T1⭐⭐",
      "Gold T1⭐⭐⭐",
      "Gold T2",
      "Gold T2⭐",
      "Gold T2⭐⭐",
      "Gold T2⭐⭐⭐",
      "Gold T3",
      "Gold T3⭐",
      "Gold T3⭐⭐",
      "Gold T3⭐⭐⭐",
      "Red",
      "Red⭐",
      "Red⭐⭐",
      "Red⭐⭐⭐",
      "Red T1",
      "Red T1⭐",
      "Red T1⭐⭐",
      "Red T1⭐⭐⭐",
      "Red T2",
      "Red T2⭐",
      "Red T2⭐⭐",
      "Red T2⭐⭐⭐",
      "Red T3",
      "Red T3⭐",
      "Red T3⭐⭐",
      "Red T3⭐⭐⭐",
      "Red T4",
      "Red T4⭐",
      "Red T4⭐⭐",
      "Red T4⭐⭐⭐",
      "Red T5",
      "Red T5⭐",
      "Red T5⭐⭐",
      "Red T5⭐⭐⭐",
      "Red T6",
      "Red T6⭐",
      "Red T6⭐⭐",
      "Red T6⭐⭐⭐",
    ];
    const compact = String(level || "")
      .toLowerCase()
      .replace(/[🌟⭐]/g, "*")
      .replace(/\s+/g, "");
    for (let i = 0; i < levels.length; i += 1) {
      const candidate = levels[i].toLowerCase().replace(/[🌟⭐]/g, "*").replace(/\s+/g, "");
      if (candidate === compact) return i;
    }
    return -1;
  };

  /** @see optimizer API `weightSettings.profile` enum */
  const GOVERNOR_GEAR_WEIGHT_PROFILE_IDS = new Set([
    "combat",
    "balance",
    "unweighted",
    "custom",
    "attackTank",
    "extremeInfantry",
    "extremeArchery",
    "extremeCavalry",
    "userCustom",
    "earlyGameGrowth",
    "earlyGameCombat",
    "gen4NewNormal",
  ]);

  const normalizeGovernorGearWeightProfile = (profile) => {
    if (profile === "futureProofed") return "gen4NewNormal";
    return profile;
  };

  const payload = {
    resources: {
      satin: Number(input.satin || 0),
      gildedThreads: Number(input.gildedThreads || 0),
      artisansVision: Number(input.artisansVision || 0),
    },
    pieceLevels: {
      infantry_gear_1: toStep(input.shirt),
      infantry_gear_2: toStep(input.pants),
      cavalry_gear_1: toStep(input.hat),
      cavalry_gear_2: toStep(input.chain),
      archery_gear_1: toStep(input.ring),
      archery_gear_2: toStep(input.baton),
    },
    troopTypeFilter: "all",
    optimizationMode: "optimize-stats",
    maxUpgrades: 100,
    weightSettings: {
      enabled: true,
      profile: "gen4NewNormal",
      scalingAmplifier: 1.25,
    },
  };

  if (input.troopTypeFilter && ["all", "infantry", "cavalry", "archery"].includes(input.troopTypeFilter)) {
    payload.troopTypeFilter = input.troopTypeFilter;
  }
  if (input.optimizationMode && ["optimize-stats", "optimize-events"].includes(input.optimizationMode)) {
    payload.optimizationMode = input.optimizationMode;
  }
  if (Number.isFinite(Number(input.maxUpgrades)) && Number(input.maxUpgrades) > 0) {
    payload.maxUpgrades = Math.floor(Number(input.maxUpgrades));
  }
  if (input.weightSettings && input.weightSettings.enabled && input.weightSettings.profile) {
    const profile = normalizeGovernorGearWeightProfile(input.weightSettings.profile);
    if (GOVERNOR_GEAR_WEIGHT_PROFILE_IDS.has(profile)) {
      payload.weightSettings = {
        enabled: true,
        profile,
        scalingAmplifier: Number.isFinite(Number(input.weightSettings.scalingAmplifier))
          ? Number(input.weightSettings.scalingAmplifier)
          : 1.25,
      };
    }
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return {
      ok: false,
      code: "OPTIMIZER_FAILED",
      message: "Could not reach optimizer API.",
    };
  }

  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }

  if (res.ok && body && body.success) {
    return { ok: true, data: body.result ?? {} };
  }

  let lastError = `Optimizer API returned status ${res.status}.`;
  if (body && typeof body.message === "string" && body.message.trim()) {
    lastError = body.message;
  } else if (body && typeof body.error === "string" && body.error.trim()) {
    lastError = body.error;
  }
  if (lastError.includes("heroes.") || lastError.includes("resources.xpParts10")) {
    return {
      ok: false,
      code: "GOV_GEAR_OPTIMIZER_UNAVAILABLE",
      message:
        "Governor Gear optimizer service is currently unavailable from the bot. Please use the optimizer page directly for now.",
    };
  }

  return { ok: false, code: "OPTIMIZER_FAILED", message: lastError };
}

module.exports = {
  fetchPlayerInfo,
  fetchKvkMatches,
  fetchKvkMatchesForKingdom,
  fetchKingdomTrackerById,
  fetchGovernorGearOptimization,
};
