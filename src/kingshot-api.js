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
const transferCache = new Map();
const TRANSFER_CACHE_TTL_MS = 5 * 60_000;
const transferHistoryCache = new Map();
const TRANSFER_HISTORY_CACHE_TTL_MS = 10 * 60_000;

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

/** API `charmLevels` keys — order: Cav → Inf → Arch, piece 1 then 2, charms 1–3 each. */
const CHARM_LEVEL_API_KEYS = [
  "cavalry_gear_1_charm_1",
  "cavalry_gear_1_charm_2",
  "cavalry_gear_1_charm_3",
  "cavalry_gear_2_charm_1",
  "cavalry_gear_2_charm_2",
  "cavalry_gear_2_charm_3",
  "infantry_gear_1_charm_1",
  "infantry_gear_1_charm_2",
  "infantry_gear_1_charm_3",
  "infantry_gear_2_charm_1",
  "infantry_gear_2_charm_2",
  "infantry_gear_2_charm_3",
  "archery_gear_1_charm_1",
  "archery_gear_1_charm_2",
  "archery_gear_1_charm_3",
  "archery_gear_2_charm_1",
  "archery_gear_2_charm_2",
  "archery_gear_2_charm_3",
];

/**
 * @param {{
 *   charmGuides: number,
 *   charmDesigns: number,
 *   charmLevels?: Record<string, number>,
 *   troopTypeFilter?: string,
 *   optimizationMode?: string,
 *   maxUpgrades?: number,
 *   weightSettings?: { enabled: boolean, profile: string, scalingAmplifier?: number },
 * }} input
 * @returns {Promise<{ ok: true, data: any } | { ok: false, code: string, message: string }>}
 */
async function fetchCharmsOptimization(input) {
  const endpoint = "https://api.kingshotoptimizer.com/charms";

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

  const charmLevels = {};
  for (const key of CHARM_LEVEL_API_KEYS) {
    const raw =
      input.charmLevels && Object.prototype.hasOwnProperty.call(input.charmLevels, key)
        ? input.charmLevels[key]
        : 0;
    const v = Number(raw ?? 0);
    charmLevels[key] = Math.max(0, Math.min(22, Number.isFinite(v) ? Math.floor(v) : 0));
  }

  const payload = {
    resources: {
      charmGuides: Math.max(0, Math.floor(Number(input.charmGuides || 0))),
      charmDesigns: Math.max(0, Math.floor(Number(input.charmDesigns || 0))),
    },
    charmLevels,
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

  return { ok: false, code: "OPTIMIZER_FAILED", message: lastError };
}

/**
 * Fetch transfer windows and optional kingdom "last leading transfer" hint from
 * Kingshot Optimizer transfer page text/HTML.
 *
 * @param {{ kingdomId?: number }} options
 * @returns {Promise<{ ok: true, data: { windows: string[], future: string[], past: string[], kingdomLastLeading?: string|null } } | { ok: false, code: string, message: string }>}
 */
async function fetchTransferWindows(options = {}) {
  const kingdomId = Number(options.kingdomId);
  const cacheKey = Number.isFinite(kingdomId) && kingdomId > 0 ? `k:${kingdomId}` : "all";
  const cached = transferCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRANSFER_CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  const url = "https://kingshotoptimizer.com/kvk-rankings/transfers";
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain,*/*" } });
  } catch (_) {
    return {
      ok: false,
      code: "NETWORK",
      message: "Could not reach Kingshot Optimizer transfers page.",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: `Transfers page returned status ${res.status}.`,
    };
  }
  const text = await res.text();
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();

  const windowMatches = Array.from(
    cleaned.matchAll(/Transfer\s+\d+\s*[–-]\s*[A-Za-z]{3}\s+\d{1,2},\s+\d{4}/g)
  ).map((m) => m[0].replace(/\s+/g, " ").trim());
  const uniqueWindows = Array.from(new Set(windowMatches));
  const now = Date.now();
  const parseWindowDate = (label) => {
    const m = label.match(/[–-]\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
    if (!m) return NaN;
    return Date.parse(m[1]);
  };
  const sorted = uniqueWindows
    .map((label) => ({ label, ts: parseWindowDate(label) }))
    .sort((a, b) => (Number.isNaN(b.ts) ? -1 : b.ts) - (Number.isNaN(a.ts) ? -1 : a.ts));
  const future = sorted.filter((x) => !Number.isNaN(x.ts) && x.ts >= now).map((x) => x.label);
  const past = sorted.filter((x) => !Number.isNaN(x.ts) && x.ts < now).map((x) => x.label);

  let kingdomLastLeading = null;
  if (Number.isFinite(kingdomId) && kingdomId > 0) {
    const kk = `KK${Math.floor(kingdomId)}`;
    const idx = cleaned.indexOf(kk);
    if (idx >= 0) {
      const segment = cleaned.slice(idx, Math.min(cleaned.length, idx + 380));
      const lm = segment.match(/(Transfer\s+\d+\s*[–-]\s*[A-Za-z]{3}\s+\d{1,2},\s+\d{4}|Never)/i);
      if (lm) kingdomLastLeading = lm[1];
    }
  }

  const data = {
    windows: sorted.map((x) => x.label),
    future,
    past,
    kingdomLastLeading,
  };
  transferCache.set(cacheKey, { at: Date.now(), data });
  return { ok: true, data };
}

/**
 * Parse transfer-history page and map transfer group/range/progress for a kingdom.
 *
 * @param {{ kingdomId: number }} options
 * @returns {Promise<{ ok: true, data: { kingdomId: number, participation: Array<{ window: string, group: number, rangeStart: number, rangeEnd: number, progress: string }>, windows: string[] } } | { ok: false, code: string, message: string }>}
 */
async function fetchTransferHistoryForKingdom(options) {
  const kingdomId = Number(options?.kingdomId);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    return { ok: false, code: "BAD_REQUEST", message: "Invalid kingdom ID." };
  }
  const cacheKey = String(Math.floor(kingdomId));
  const cached = transferHistoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRANSFER_HISTORY_CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  const url = "https://kingshot.net/transfer-history";
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain,*/*" } });
  } catch (_) {
    return { ok: false, code: "NETWORK", message: "Could not reach kingshot.net transfer history." };
  }
  if (!res.ok) {
    return { ok: false, code: "BAD_RESPONSE", message: `Transfer history page returned status ${res.status}.` };
  }
  const html = await res.text();
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

  const dateRe = /([A-Z][a-z]+ \d{1,2}, \d{4})/g;
  const windows = [];
  let dm;
  while ((dm = dateRe.exec(cleaned))) {
    const label = dm[1];
    // Keep only likely transfer windows around "Ends on"/"Groups" vicinity.
    const slice = cleaned.slice(Math.max(0, dm.index - 30), Math.min(cleaned.length, dm.index + 220));
    if (/Ends on|Groups|Transfer Preview/i.test(slice)) {
      windows.push({ label, idx: dm.index });
    }
  }
  const uniq = [];
  const seen = new Set();
  for (const x of windows) {
    if (seen.has(x.label)) continue;
    seen.add(x.label);
    uniq.push(x);
  }

  const participation = [];
  for (let i = 0; i < uniq.length; i += 1) {
    const start = uniq[i].idx;
    const end = i + 1 < uniq.length ? uniq[i + 1].idx : cleaned.length;
    const seg = cleaned.slice(start, end);

    const groupRe = /Group\s+(\d+)\s+(\d+)\s*-\s*(\d+)([\s\S]*?)(?=Group\s+\d+\s+\d+\s*-\s*\d+|$)/g;
    let gm;
    while ((gm = groupRe.exec(seg))) {
      const group = Number(gm[1]);
      const rangeStart = Number(gm[2]);
      const rangeEnd = Number(gm[3]);
      if (!Number.isFinite(group) || !Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) continue;
      if (kingdomId < rangeStart || kingdomId > rangeEnd) continue;
      const tail = gm[4] || "";
      let progress = "N/A";
      const pm = tail.match(/Kingdom Progress\s+([\s\S]*?)(?:View Details|Leading Kingdoms|Group\s+\d+|$)/i);
      if (pm && pm[1]) {
        progress = pm[1].replace(/\s+/g, " ").trim();
      }
      participation.push({
        window: uniq[i].label,
        group,
        rangeStart,
        rangeEnd,
        progress,
      });
    }
  }

  const data = {
    kingdomId: Math.floor(kingdomId),
    participation,
    windows: uniq.map((x) => x.label),
  };
  transferHistoryCache.set(cacheKey, { at: Date.now(), data });
  return { ok: true, data };
}

module.exports = {
  CHARM_LEVEL_API_KEYS,
  fetchPlayerInfo,
  fetchKvkMatches,
  fetchKvkMatchesForKingdom,
  fetchKingdomTrackerById,
  fetchGovernorGearOptimization,
  fetchCharmsOptimization,
  fetchTransferWindows,
  fetchTransferHistoryForKingdom,
};
