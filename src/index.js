require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { promisify } = require("util");
const { execFile, spawn } = require("child_process");
const readline = require("readline");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
} = require("discord.js");
const {
  fetchPlayerInfo,
  fetchKvkMatches,
  fetchKvkMatchesForKingdom,
  fetchKingdomTrackerById,
} = require("./kingshot-api");
const {
  loadGovGearTemplateBank,
  matchGovGearSlotsFromTemplateBank,
} = require("./gov-gear-templates");
const { matchBackpackResourceCells, numberRectForAssignment } = require("./gov-resource-icons");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID || "";
const allowedChannelId = process.env.ALLOWED_CHANNEL_ID || "";
const brandImageUrl = process.env.BRAND_IMAGE_URL || "";
const localBrandImagePath = path.join(__dirname, "..", "img", "pazam.png");
const localBrandImageName = "pazam.png";
const enableSimpleMessages =
  String(process.env.ENABLE_SIMPLE_MESSAGES).toLowerCase() === "true";
const nicknameChannelId = (process.env.NICKNAME_CHANNEL_ID || "").trim();
const enableNicknameChannel = Boolean(nicknameChannelId);
const nicknameCooldownSec = Math.max(
  0,
  Number.parseInt(String(process.env.NICKNAME_COOLDOWN_SECONDS || "60"), 10) || 0
);
const nicknameDeleteMessage =
  String(process.env.NICKNAME_DELETE_MESSAGE).toLowerCase() === "true";
const needsMessageIntents = enableSimpleMessages || enableNicknameChannel;
const governorGearOptimizerApiBase =
  (process.env.GOV_GEAR_OPTIMIZER_API || "https://api.kingshotoptimizer.com").trim();
const govGearTemplateDir =
  (process.env.GOV_GEAR_TEMPLATE_DIR || "").trim() ||
  path.join(__dirname, "..", "Kingshot-image");
const govResourceIconDir =
  (process.env.GOV_RESOURCE_TEMPLATE_DIR || "").trim() ||
  path.join(__dirname, "..", "img", "gov-resources");
const govResourceIconMinScore = (() => {
  const v = Number.parseFloat(String(process.env.GOV_RESOURCE_ICON_MIN_SCORE || "0.19"), 10);
  if (!Number.isFinite(v)) return 0.19;
  return Math.min(0.55, Math.max(0.08, v));
})();
/** If Artisan's Vision OCR exceeds this, try other icon-scored cells (scroll false positives). 0 disables. */
const govResourceVisionOcrMax = (() => {
  const v = Number.parseInt(String(process.env.GOV_RESOURCE_VISION_OCR_MAX || "800"), 10);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v;
})();
const ocrEngine = (process.env.OCR_ENGINE || "paddle").trim().toLowerCase();
const ocrPythonBin = (process.env.OCR_PYTHON_BIN || "python").trim();
const paddleOcrBridgePath = path.join(__dirname, "paddle_ocr_bridge.py");
const paddleOcrWorkerPath = path.join(__dirname, "paddle_ocr_worker.py");
const paddleOcrWorkerEnabled =
  String(process.env.PADDLE_OCR_WORKER || "true").toLowerCase() !== "false";
const paddleOcrPrewarm =
  String(process.env.PADDLE_OCR_PREWARM || "true").toLowerCase() !== "false";
const execFileAsync = promisify(execFile);
let paddleFallbackWarned = false;
let lastOcrEngineUsed = "unknown";

/** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
let paddleWorkerProc = null;
/** @type {import('readline').Interface | null} */
let paddleWorkerStdoutRl = null;
let paddleWorkerReady = false;
/** @type {Promise<void> | null} */
let paddleWorkerBootPromise = null;
/** @type {Promise<void>} */
let paddleWorkerRequestChain = Promise.resolve();

function killPaddleWorker() {
  paddleWorkerReady = false;
  if (paddleWorkerStdoutRl) {
    try {
      paddleWorkerStdoutRl.close();
    } catch {
      // ignore
    }
    paddleWorkerStdoutRl = null;
  }
  if (paddleWorkerProc) {
    try {
      paddleWorkerProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    paddleWorkerProc = null;
  }
}

function resetPaddleWorkerAfterFailure() {
  killPaddleWorker();
}

function registerPaddleWorkerShutdownHooks() {
  const fn = () => {
    try {
      killPaddleWorker();
    } catch {
      // ignore
    }
  };
  process.once("SIGINT", fn);
  process.once("SIGTERM", fn);
}
registerPaddleWorkerShutdownHooks();

/**
 * @param {import('readline').Interface} rl
 * @param {number} timeoutMs
 */
function readlineOnce(rl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      rl.removeListener("line", onLine);
      reject(new Error("Paddle worker read timeout"));
    }, timeoutMs);
    function onLine(line) {
      clearTimeout(t);
      rl.removeListener("line", onLine);
      resolve(String(line || "").trim());
    }
    rl.once("line", onLine);
  });
}

async function ensurePaddleWorkerReady() {
  if (!paddleOcrWorkerEnabled) {
    throw new Error("Paddle worker disabled (PADDLE_OCR_WORKER=false)");
  }
  if (paddleWorkerProc && paddleWorkerReady) {
    return;
  }
  if (paddleWorkerBootPromise) {
    await paddleWorkerBootPromise;
    return;
  }
  paddleWorkerBootPromise = (async () => {
    killPaddleWorker();
    const proc = spawn(ocrPythonBin, [paddleOcrWorkerPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    paddleWorkerProc = proc;
    paddleWorkerStdoutRl = readline.createInterface({ input: proc.stdout });
    proc.on("exit", () => {
      paddleWorkerReady = false;
      paddleWorkerProc = null;
      if (paddleWorkerStdoutRl) {
        try {
          paddleWorkerStdoutRl.close();
        } catch {
          // ignore
        }
        paddleWorkerStdoutRl = null;
      }
    });
    proc.on("error", () => {
      resetPaddleWorkerAfterFailure();
    });
    const first = await readlineOnce(paddleWorkerStdoutRl, 180000);
    if (first !== "READY") {
      resetPaddleWorkerAfterFailure();
      throw new Error(`Paddle worker did not become ready (got: ${first || "(empty)"})`);
    }
    paddleWorkerReady = true;
  })();
  try {
    await paddleWorkerBootPromise;
  } finally {
    paddleWorkerBootPromise = null;
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 */
function enqueuePaddleWorkerTask(fn) {
  const run = paddleWorkerRequestChain.then(fn, fn);
  paddleWorkerRequestChain = run.catch(() => {});
  return run;
}

const governorGearPieceKeys = {
  infantry1: "infantry_gear_1",
  infantry2: "infantry_gear_2",
  cavalry1: "cavalry_gear_1",
  cavalry2: "cavalry_gear_2",
  archery1: "archery_gear_1",
  archery2: "archery_gear_2",
};

const governorGearStepLabels = [
  "No gear",
  "Green 0*",
  "Green 1*",
  "Blue 0*",
  "Blue 1*",
  "Blue 2*",
  "Blue 3*",
  "Purple 0*",
  "Purple 1*",
  "Purple 2*",
  "Purple 3*",
  "Purple T1 0*",
  "Purple T1 1*",
  "Purple T1 2*",
  "Purple T1 3*",
  "Gold 0*",
  "Gold 1*",
  "Gold 2*",
  "Gold 3*",
  "Gold T1 0*",
  "Gold T1 1*",
  "Gold T1 2*",
  "Gold T1 3*",
  "Gold T2 0*",
  "Gold T2 1*",
  "Gold T2 2*",
  "Gold T2 3*",
  "Gold T3 0*",
  "Gold T3 1*",
  "Gold T3 2*",
  "Gold T3 3*",
  "Red 0*",
  "Red 1*",
  "Red 2*",
  "Red 3*",
  "Red T1 0*",
  "Red T1 1*",
  "Red T1 2*",
  "Red T1 3*",
  "Red T2 0*",
  "Red T2 1*",
  "Red T2 2*",
  "Red T2 3*",
  "Red T3 0*",
  "Red T3 1*",
  "Red T3 2*",
  "Red T3 3*",
  "Red T4 0*",
  "Red T4 1*",
  "Red T4 2*",
  "Red T4 3*",
  "Red T5 0*",
  "Red T5 1*",
  "Red T5 2*",
  "Red T5 3*",
  "Red T6 0*",
  "Red T6 1*",
  "Red T6 2*",
  "Red T6 3*",
];

const governorGearStepLookup = Object.fromEntries(
  governorGearStepLabels.map((label, idx) => [
    label.toLowerCase().replace(/[^a-z0-9]/g, ""),
    idx,
  ])
);

function formatGovGearStep(step) {
  if (!Number.isFinite(Number(step))) return "Unknown";
  const s = Number(step);
  return governorGearStepLabels[s] || `Step ${s}`;
}

const governorGearDefaultWeights = {
  Infantry_Health: 1,
  Infantry_Lethality: 1,
  Cavalry_Health: 1,
  Cavalry_Lethality: 1,
  Archery_Health: 1,
  Archery_Lethality: 1,
};

/** @type {Map<string, number>} */
const nicknameCooldownUntil = new Map();

if (!token || !clientId) {
  console.error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("kingshot")
    .setDescription("Look up a Kingshot player by in-game ID")
    .addStringOption((o) =>
      o
        .setName("player_id")
        .setDescription("Numeric player ID from the game")
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("kvkmatches")
    .setDescription("Get all available KvK records for a kingdom")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Kingdom ID (example: 220)")
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("kingdomage")
    .setDescription("Show kingdom age and open time")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Kingdom ID (example: 220)")
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("govgearopt")
    .setDescription("Optimize governor gear (manual resources + gear templates)")
    .addAttachmentOption((o) =>
      o
        .setName("gear_image")
        .setDescription("Governor profile screenshot (gear slots matched vs reference crops)")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("satin").setDescription("Available Satin (optional manual override)").setRequired(false)
    )
    .addIntegerOption((o) =>
      o
        .setName("gilded_threads")
        .setDescription("Available Gilded Threads (optional manual override)")
        .setRequired(false)
    )
    .addIntegerOption((o) =>
      o
        .setName("artisans_vision")
        .setDescription("Available Artisan's Vision (optional manual override)")
        .setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("infantry1").setDescription("Manual override for Infantry Gear Piece 1 level")
    )
    .addStringOption((o) =>
      o
        .setName("infantry1_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addIntegerOption((o) =>
      o.setName("infantry2").setDescription("Manual override for Infantry Gear Piece 2 level")
    )
    .addStringOption((o) =>
      o
        .setName("infantry2_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addIntegerOption((o) =>
      o.setName("cavalry1").setDescription("Manual override for Cavalry Gear Piece 1 level")
    )
    .addStringOption((o) =>
      o
        .setName("cavalry1_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addIntegerOption((o) =>
      o.setName("cavalry2").setDescription("Manual override for Cavalry Gear Piece 2 level")
    )
    .addStringOption((o) =>
      o
        .setName("cavalry2_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addIntegerOption((o) =>
      o.setName("archery1").setDescription("Manual override for Archery Gear Piece 1 level")
    )
    .addStringOption((o) =>
      o
        .setName("archery1_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addIntegerOption((o) =>
      o.setName("archery2").setDescription("Manual override for Archery Gear Piece 2 level")
    )
    .addStringOption((o) =>
      o
        .setName("archery2_label")
        .setDescription("Manual override label (e.g., Red T2 0* or Blue 1*)")
    )
    .addBooleanOption((o) =>
      o
        .setName("show_crops")
        .setDescription("Attach debug PNG of the 6 crops (detected bounds vs full image)")
    )
    .toJSON(),
];

function channelAllowed(channelId) {
  if (!allowedChannelId) return true;
  return channelId === allowedChannelId;
}

/**
 * Build a server nickname: display name + " #<kingdomId>" (max 32 chars for Discord).
 * If the name already ends with "#<digits>", replace that suffix with the new kingdom id
 * instead of appending a second "#…".
 * @param {string} displayName
 * @param {string} kingdomDigits
 */
function buildKingdomSuffixNickname(displayName, kingdomDigits) {
  const suffix = ` #${kingdomDigits}`;
  const maxLen = 32;
  const maxBase = maxLen - suffix.length;
  if (maxBase < 1) {
    return kingdomDigits.slice(0, maxLen);
  }
  let base = String(displayName || "member")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/@/g, "")
    .trim();
  if (!base) base = "member";
  // Strip trailing "#123" or " #123" so we update the kingdom tag instead of stacking.
  if (/(?:\s+)?#\d+$/.test(base)) {
    base = base.replace(/(?:\s+)?#\d+$/, "").trim();
  }
  if (!base) base = "member";
  if (base.length > maxBase) base = base.slice(0, maxBase);
  return `${base}${suffix}`;
}

/**
 * @param {import('discord.js').Message} message
 */
async function handleNicknameChannelMessage(message) {
  const content = message.content.trim();
  if (!/^\d{1,4}$/.test(content)) return;

  const now = Date.now();
  if (nicknameCooldownSec > 0) {
    const key = `${message.guildId}:${message.author.id}`;
    const until = nicknameCooldownUntil.get(key) || 0;
    if (now < until) {
      const waitSec = Math.ceil((until - now) / 1000);
      await message.reply({
        content: `Please wait ${waitSec}s before changing your nickname again.`,
      });
      return;
    }
    nicknameCooldownUntil.set(key, now + nicknameCooldownSec * 1000);
  }

  let member = message.member;
  if (!member) {
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch {
      await message.reply({ content: "Could not load your member profile. Try again." });
      return;
    }
  }

  const kingdomDigits = content;
  const displayName = member.displayName || member.user.username;
  const newNick = buildKingdomSuffixNickname(displayName, kingdomDigits);

  try {
    await member.setNickname(newNick);
  } catch (err) {
    const code = err.code ?? err?.rawError?.code;
    if (nicknameCooldownSec > 0) {
      const key = `${message.guildId}:${message.author.id}`;
      nicknameCooldownUntil.delete(key);
    }
    if (code === 50013) {
      await message.reply({
        content:
          "I cannot set your nickname (missing **Manage Nicknames**, or your highest role is above the bot's role, or you are the server owner). Ask an admin to fix role order or permissions.",
      });
      return;
    }
    console.error("setNickname failed:", err);
    await message.reply({
      content: "Could not set nickname. Check the format and try again, or ask a moderator.",
    });
    return;
  }

  if (nicknameDeleteMessage) {
    try {
      await message.delete();
    } catch {
      /* ignore — may lack Manage Messages */
    }
  } else {
    try {
      await message.react("✅");
    } catch {
      await message.reply({ content: `Nickname set to: **${newNick}**` });
    }
  }
}

function applyBrandThumbnail(embed) {
  if (fs.existsSync(localBrandImagePath)) {
    embed.setThumbnail(`attachment://${localBrandImageName}`);
  } else if (/^https?:\/\//i.test(brandImageUrl)) {
    embed.setThumbnail(brandImageUrl);
  }
  return embed;
}

function getBrandAttachments() {
  if (!fs.existsSync(localBrandImagePath)) return [];
  return [new AttachmentBuilder(localBrandImagePath, { name: localBrandImageName })];
}

function buildEmbedReplyPayload(embeds) {
  const files = getBrandAttachments();
  return files.length ? { embeds, files } : { embeds };
}

/**
 * @param {import('discord.js').Attachment} attachment
 */
async function attachmentToBuffer(attachment) {
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(`Failed to download image (${res.status}).`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function runOcrOnBuffer(buffer, config = {}) {
  const out = await runOcrDetailedOnBuffer(buffer, config);
  return String(out?.text || "");
}

async function runOcrDetailedOnBuffer(buffer, config = {}) {
  const wantTesseract = ocrEngine === "tesseract";
  const includeWords = config.includeWords !== false;
  if (!wantTesseract) {
    try {
      const out = await runPaddleOcrDetailedOnBuffer(buffer, { includeWords });
      lastOcrEngineUsed = "paddle";
      return out;
    } catch (err) {
      if (!paddleFallbackWarned) {
        console.warn(
          "PaddleOCR unavailable, falling back to Tesseract:",
          err?.message || err
        );
        paddleFallbackWarned = true;
      }
    }
  }
  const out = await Tesseract.recognize(buffer, "eng", config);
  lastOcrEngineUsed = "tesseract";
  return out?.data || {};
}

/**
 * @param {Buffer} buffer
 * @param {{ includeWords?: boolean }} [options]
 */
async function runPaddleOcrDetailedOnBuffer(buffer, options = {}) {
  const includeWords = options.includeWords !== false;
  const tmpName = `kingshot-ocr-${Date.now()}-${crypto.randomUUID()}.png`;
  const tmpPath = path.join(os.tmpdir(), tmpName);
  const outName = `kingshot-ocr-out-${Date.now()}-${crypto.randomUUID()}.json`;
  const outPath = path.join(os.tmpdir(), outName);
  await fs.promises.writeFile(tmpPath, buffer);

  const runSubprocess = async () => {
    const mode = includeWords ? "detailed" : "text";
    const { stdout } = await execFileAsync(
      ocrPythonBin,
      [paddleOcrBridgePath, tmpPath, mode],
      { timeout: 120000, maxBuffer: 32 * 1024 * 1024 }
    );
    const parsed = JSON.parse(String(stdout || "{}"));
    if (!parsed || parsed.ok !== true || !parsed.data) {
      throw new Error(parsed?.error || "Invalid PaddleOCR response");
    }
    return parsed.data;
  };

  const runWorker = async () => {
    await ensurePaddleWorkerReady();
    if (!paddleWorkerProc?.stdin || !paddleWorkerStdoutRl) {
      throw new Error("Paddle worker not available");
    }
    const payload =
      JSON.stringify({
        in: tmpPath,
        out: outPath,
        words: includeWords,
      }) + "\n";
    await enqueuePaddleWorkerTask(async () => {
      const stdin = paddleWorkerProc?.stdin;
      if (!stdin) throw new Error("Paddle worker stdin missing");
      await new Promise((resolve, reject) => {
        stdin.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      const line = await readlineOnce(paddleWorkerStdoutRl, 120000);
      if (line !== "OK") {
        throw new Error(`Paddle worker bad ack: ${line || "(empty)"}`);
      }
    });
    const raw = await fs.promises.readFile(outPath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || parsed.ok !== true || !parsed.data) {
      throw new Error(parsed?.error || "Invalid PaddleOCR worker response");
    }
    return parsed.data;
  };

  try {
    if (paddleOcrWorkerEnabled) {
      try {
        return await runWorker();
      } catch (err) {
        console.warn("Paddle OCR worker failed, retrying with subprocess:", err?.message || err);
        resetPaddleWorkerAfterFailure();
      }
    }
    return await runSubprocess();
  } finally {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore
    }
    try {
      await fs.promises.unlink(outPath);
    } catch {
      // ignore
    }
  }
}

function parseNumberToken(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number(digits);
}

/**
 * Parse counts like 1,058,170 (US) or 10.972 / 1.058.170 (dot as thousands separator from OCR).
 */
function parseInventoryCountToken(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+$/.test(s)) {
    return Number(s.replace(/,/g, ""));
  }
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return Number(s.replace(/\./g, ""));
  }
  if (/^\d{1,3},\d{3}$/.test(s)) {
    return Number(s.replace(/,/g, ""));
  }
  return parseNumberToken(s);
}

/** @param {any} w */
function wordBBoxPixels(w) {
  const b = w?.bbox;
  if (b && Number.isFinite(b.x0) && Number.isFinite(b.x1)) {
    return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
  }
  if (b && Number.isFinite(b.left) && Number.isFinite(b.width)) {
    return {
      x0: b.left,
      y0: b.top,
      x1: b.left + b.width,
      y1: b.top + b.height,
    };
  }
  if (Number.isFinite(w?.left) && Number.isFinite(w?.width)) {
    return {
      x0: w.left,
      y0: w.top,
      x1: w.left + w.width,
      y1: w.top + w.height,
    };
  }
  return null;
}

/**
 * Map OCR word boxes to the three backpack count regions (reference 368×782), by nearest center.
 * Runs before keyword/rect heuristics so large counts like 1,058,170 are not confused with other UI numbers.
 */
async function extractGovResourcesByNearestWordSlots(buffer) {
  const empty = { satin: null, gildedThreads: null, artisansVision: null };
  const meta = await sharp(buffer).metadata();
  const imageW = meta.width;
  const imageH = meta.height;
  if (!imageW || !imageH) return empty;

  const refW = 368;
  const refH = 782;
  const baseSlots = {
    satin: { left: 22, top: 297, width: 92, height: 36 },
    gildedThreads: { left: 104, top: 387, width: 102, height: 38 },
    artisansVision: { left: 191, top: 387, width: 102, height: 38 },
  };
  const bounds = { left: 0, top: 0, width: imageW, height: imageH };
  /** @type {Record<string, { cx: number; cy: number }>} */
  const slotCenters = {};
  for (const [k, baseRect] of Object.entries(baseSlots)) {
    const r = makeRectInBounds(baseRect, bounds, refW, refH, imageW, imageH);
    // Count text usually sits slightly low in the strip (not the vertical midpoint).
    slotCenters[k] = { cx: r.left + r.width / 2, cy: r.top + r.height * 0.62 };
  }

  const maxDistPx = Math.max(56, 0.24 * Math.min(imageW, imageH));

  let data;
  try {
    data = await runOcrDetailedOnBuffer(buffer, {
      includeWords: true,
      tessedit_pageseg_mode: "11",
      tessedit_char_whitelist: "0123456789,.",
    });
  } catch {
    return empty;
  }

  const words = Array.isArray(data?.words) ? data.words : [];
  const satinRect = makeRectInBounds(baseSlots.satin, bounds, refW, refH, imageW, imageH);
  const padX = Math.round(0.06 * imageW);
  const padY = Math.round(0.1 * imageH);
  const satinSearchRect = clampRect(
    {
      left: satinRect.left - padX,
      top: Math.max(0, satinRect.top - padY * 2),
      width: satinRect.width + padX * 2,
      height: satinRect.height + padY * 5,
    },
    imageW,
    imageH
  );
  const satinGildedMidX = (slotCenters.satin.cx + slotCenters.gildedThreads.cx) / 2;

  /** @type {{ slot: string; dist: number; value: number; wi: number }[]} */
  const pairsNoSatin = [];
  words.forEach((w, wi) => {
    const val = parseInventoryCountToken(w?.text || "");
    if (!Number.isFinite(val) || val <= 0) return;
    const box = wordBBoxPixels(w);
    if (!box) return;
    const wcx = (box.x0 + box.x1) / 2;
    const wcy = (box.y0 + box.y1) / 2;
    for (const slot of ["gildedThreads", "artisansVision"]) {
      const sc = slotCenters[slot];
      const dist = Math.hypot(wcx - sc.cx, wcy - sc.cy);
      if (dist <= maxDistPx) {
        pairsNoSatin.push({ slot, dist, value: val, wi });
      }
    }
  });

  pairsNoSatin.sort((a, b) => a.dist - b.dist || a.wi - b.wi);
  const usedWord = new Set();
  const out = { ...empty };
  for (const p of pairsNoSatin) {
    if (out[p.slot] !== null) continue;
    if (usedWord.has(p.wi)) continue;
    out[p.slot] = p.value;
    usedWord.add(p.wi);
  }

  // Satin: another stack count (e.g. 2,390) can sit closer to the ticket anchor than the real total
  // (e.g. 1,058,170). Assign threads/vision first, then take the largest plausible number in the left
  // satin column / expanded strip (same raw OCR line family as the true total).
  const satinSc = slotCenters.satin;
  const satinPool = [];
  words.forEach((w, wi) => {
    if (usedWord.has(wi)) return;
    const val = parseInventoryCountToken(w?.text || "");
    if (!Number.isFinite(val) || val <= 0) return;
    const box = wordBBoxPixels(w);
    if (!box) return;
    const wcx = (box.x0 + box.x1) / 2;
    const wcy = (box.y0 + box.y1) / 2;
    if (wcx >= satinGildedMidX) return;
    const distS = Math.hypot(wcx - satinSc.cx, wcy - satinSc.cy);
    const inBand =
      distS <= maxDistPx * 1.65 ||
      (wcx >= satinSearchRect.left &&
        wcx <= satinSearchRect.left + satinSearchRect.width &&
        wcy >= satinSearchRect.top &&
        wcy <= satinSearchRect.top + satinSearchRect.height);
    if (!inBand) return;
    satinPool.push({ value: val, dist: distS, wi });
  });

  if (satinPool.length) {
    satinPool.sort((a, b) => b.value - a.value || a.dist - b.dist);
    const pick = satinPool[0];
    out.satin = pick.value;
    usedWord.add(pick.wi);
  } else {
    let best = null;
    words.forEach((w, wi) => {
      if (usedWord.has(wi)) return;
      const val = parseInventoryCountToken(w?.text || "");
      if (!Number.isFinite(val) || val <= 0) return;
      const box = wordBBoxPixels(w);
      if (!box) return;
      const wcx = (box.x0 + box.x1) / 2;
      const wcy = (box.y0 + box.y1) / 2;
      const dist = Math.hypot(wcx - satinSc.cx, wcy - satinSc.cy);
      if (dist > maxDistPx) return;
      if (!best || dist < best.dist) best = { value: val, dist, wi };
    });
    if (best) {
      out.satin = best.value;
      usedWord.add(best.wi);
    }
  }

  return out;
}

function normalizeOcrNumberToken(raw) {
  return String(raw || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il]/g, "1")
    .replace(/[^\d,.\s]/g, "")
    .replace(/\s+/g, "");
}

/** Slightly expand the count strip so full-image OCR word boxes still hit (same engine as `/imagerawocr`). */
function padNumberRectForWordPick(rect, imageW, imageH) {
  const xPad = rect.width * 0.12;
  const yPad = rect.height * 0.35;
  return clampRect(
    {
      left: rect.left - xPad * 0.35,
      top: rect.top - yPad * 0.4,
      width: rect.width + xPad * 0.7,
      height: rect.height + yPad * 0.85,
    },
    imageW,
    imageH
  );
}

/**
 * Parse inventory count from Paddle/Tesseract words whose center lies in rect (left-to-right order).
 * @param {any[]} words
 * @param {{ left: number; top: number; width: number; height: number }} rect
 */
function pickNumberFromWordsInRect(words, rect) {
  function overlapArea(a, b) {
    const x0 = Math.max(a.x0, b.x0);
    const y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1);
    const y1 = Math.min(a.y1, b.y1);
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    return w * h;
  }
  const hits = [];
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const rectBox = { x0: rect.left, y0: rect.top, x1: right, y1: bottom };
  for (const w of words) {
    const box = wordBBoxPixels(w);
    if (!box) continue;
    const inter = overlapArea(box, rectBox);
    const area = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
    // Accept center-inside words OR words that overlap the rect significantly.
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const centerInside = cx >= rect.left && cx <= right && cy >= rect.top && cy <= bottom;
    const overlapRatio = inter / area;
    if (!centerInside && overlapRatio < 0.26) continue;
    const t = String(w?.text || "").trim();
    if (!t) continue;
    hits.push({ x0: box.x0, t, overlapRatio });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.x0 - b.x0 || b.overlapRatio - a.overlapRatio);
  // Direct token parse is important when OCR already emits a complete number token (e.g. "1,616").
  let bestSingle = null;
  for (const h of hits) {
    const v = parseInventoryCountToken(h.t);
    if (!Number.isFinite(v)) continue;
    if (bestSingle === null || v > bestSingle) bestSingle = v;
  }
  const joined = hits.map((h) => h.t).join(" ");
  const v = extractBestNumberFromText(joined);
  if (Number.isFinite(v) && Number.isFinite(bestSingle)) return Math.max(v, bestSingle);
  if (Number.isFinite(v)) return v;
  return Number.isFinite(bestSingle) ? bestSingle : null;
}

function extractBestNumberFromText(raw) {
  const txt = normalizeOcrNumberToken(raw);
  const matches = txt.match(/\d[\d,.\s]{0,18}/g) || [];
  let best = null;
  for (const m of matches) {
    const cleaned = m.replace(/[^\d]/g, "");
    if (!cleaned) continue;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) continue;
    const digitCount = cleaned.length;
    const commaCount = (m.match(/[,]/g) || []).length;
    const score = digitCount * 10 + commaCount * 2 + Math.min(4, Math.floor(Math.log10(value + 1)));
    if (!best || score > best.score || (score === best.score && value > best.value)) {
      best = { value, score };
    }
  }
  return best ? best.value : null;
}

function extractValueByKeywords(text, keywords) {
  const source = String(text || "");
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`${escaped}\\s*[:=\\-]?\\s*([\\d][\\d,\\.\\s]*)`, "i"),
      new RegExp(`([\\d][\\d,\\.\\s]*)\\s*${escaped}`, "i"),
    ];
    for (const re of patterns) {
      const match = source.match(re);
      if (!match) continue;
      const parsed = parseInventoryCountToken(match[1]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

async function extractGovResourcesByIconMatch(buffer) {
  const empty = { satin: null, gildedThreads: null, artisansVision: null };
  let matched;
  try {
    matched = await matchBackpackResourceCells(buffer, {
      templateDir: govResourceIconDir,
      minScore: govResourceIconMinScore,
    });
  } catch {
    return { ...empty, __minAssignmentScore: 0, __perKeyScores: {} };
  }
  if (!matched) return { ...empty, __minAssignmentScore: 0, __perKeyScores: {} };
  const { assignments, layout, ranked } = matched;
  const { imageW, imageH } = layout;

  /** @type {any[]} */
  let words = [];
  try {
    const data = await runOcrDetailedOnBuffer(buffer, {
      includeWords: true,
      tessedit_pageseg_mode: "6",
    });
    words = Array.isArray(data?.words) ? data.words : [];
  } catch {
    words = [];
  }

  const out = { ...empty };
  /** @type {Record<string, number>} */
  const chosenAssignmentScore = {};
  const perKey = /** @type {Record<string, number>} */ ({});
  const assignmentScores = ["satin", "gildedThreads", "artisansVision"]
    .map((k) => (assignments[k] ? assignments[k].score : null))
    .filter((s) => typeof s === "number");
  const minAssignmentScore = assignmentScores.length ? Math.min(...assignmentScores) : 0;

  for (const key of ["satin", "gildedThreads", "artisansVision"]) {
    const asg = assignments[key];
    if (!asg) continue;
    perKey[key] = asg.score;
    chosenAssignmentScore[key] = asg.score;
    const rect = numberRectForAssignment(layout, asg);
    const pickRect = padNumberRectForWordPick(rect, imageW, imageH);
    let n = words.length ? pickNumberFromWordsInRect(words, pickRect) : null;
    if (!Number.isFinite(n)) {
      n = await ocrNumberFromRegion(buffer, rect);
    }
    if (Number.isFinite(n)) out[key] = n;
  }

  // Recovery pass: if Threads / Vision parsed as tiny values due to OCR token clipping,
  // try alternate icon candidates with near-top icon score and prefer stronger numeric reads.
  if (Array.isArray(ranked)) {
    for (const key of ["gildedThreads", "artisansVision"]) {
      if (!Number.isFinite(out[key])) continue;
      if (out[key] >= 100) continue;
      const baseScore = Number.isFinite(chosenAssignmentScore[key]) ? chosenAssignmentScore[key] : -1;
      let replacement = null;
      for (const item of ranked) {
        if (item.key !== key) continue;
        if (item.score < govResourceIconMinScore) break;
        // Keep this conservative: only look at candidates that are close in icon quality.
        if (baseScore > 0 && item.score < baseScore - 0.03) continue;
        const rect = numberRectForAssignment(layout, item);
        const pickRect = padNumberRectForWordPick(rect, imageW, imageH);
        let n = words.length ? pickNumberFromWordsInRect(words, pickRect) : null;
        if (!Number.isFinite(n)) {
          n = await ocrNumberFromRegion(buffer, rect);
        }
        if (!Number.isFinite(n)) continue;
        if (n < 100) continue;
        if (n >= out[key] * 3) {
          replacement = n;
          break;
        }
      }
      if (replacement !== null) out[key] = replacement;
    }
  }

  if (
    govResourceVisionOcrMax > 0 &&
    Number.isFinite(out.artisansVision) &&
    out.artisansVision > govResourceVisionOcrMax &&
    Array.isArray(ranked)
  ) {
    const cellKey = (r, c) => `${r},${c}`;
    const blocked = new Set();
    if (assignments.satin) blocked.add(cellKey(assignments.satin.r, assignments.satin.c));
    if (assignments.gildedThreads) {
      blocked.add(cellKey(assignments.gildedThreads.r, assignments.gildedThreads.c));
    }
    if (assignments.artisansVision) {
      blocked.add(cellKey(assignments.artisansVision.r, assignments.artisansVision.c));
    }
    let replacement = null;
    for (const item of ranked) {
      if (item.key !== "artisansVision") continue;
      if (item.score < govResourceIconMinScore) break;
      if (blocked.has(cellKey(item.r, item.c))) continue;
      const rect = numberRectForAssignment(layout, item);
      const pickRect = padNumberRectForWordPick(rect, imageW, imageH);
      let n = words.length ? pickNumberFromWordsInRect(words, pickRect) : null;
      if (!Number.isFinite(n)) {
        n = await ocrNumberFromRegion(buffer, rect);
      }
      if (Number.isFinite(n) && n <= govResourceVisionOcrMax) {
        replacement = n;
        break;
      }
    }
    if (replacement !== null) {
      out.artisansVision = replacement;
    } else {
      out.artisansVision = null;
    }
  }

  // Final sanity pass: if selected trio looks numerically implausible, try top icon alternatives
  // and choose the best score+number-consistent combination.
  if (Array.isArray(ranked)) {
    const cellKey = (r, c) => `${r},${c}`;
    /**
     * @param {"satin"|"gildedThreads"|"artisansVision"} key
     */
    const collectCandidates = async (key) => {
      const outList = [];
      const seen = new Set();
      for (const item of ranked) {
        if (item.key !== key) continue;
        if (item.score < govResourceIconMinScore * 0.9) break;
        const ck = cellKey(item.r, item.c);
        if (seen.has(ck)) continue;
        seen.add(ck);
        const rect = numberRectForAssignment(layout, item);
        const pickRect = padNumberRectForWordPick(rect, imageW, imageH);
        let n = words.length ? pickNumberFromWordsInRect(words, pickRect) : null;
        if (!Number.isFinite(n)) {
          n = await ocrNumberFromRegion(buffer, rect);
        }
        if (!Number.isFinite(n) || n <= 0) continue;
        outList.push({ r: item.r, c: item.c, score: item.score, value: n });
        if (outList.length >= 10) break;
      }
      return outList;
    };

    const currentPlausible =
      Number.isFinite(out.satin) &&
      Number.isFinite(out.gildedThreads) &&
      Number.isFinite(out.artisansVision) &&
      out.satin >= out.gildedThreads &&
      out.satin >= out.artisansVision;

    if (!currentPlausible) {
      const satinCands = await collectCandidates("satin");
      const threadCands = await collectCandidates("gildedThreads");
      const visionCands = await collectCandidates("artisansVision");
      let bestCombo = null;
      let bestMetric = -Infinity;
      for (const s of satinCands) {
        for (const t of threadCands) {
          if (cellKey(s.r, s.c) === cellKey(t.r, t.c)) continue;
          for (const v of visionCands) {
            const kS = cellKey(s.r, s.c);
            const kT = cellKey(t.r, t.c);
            const kV = cellKey(v.r, v.c);
            if (kS === kV || kT === kV) continue;
            let plaus = 0;
            plaus += s.value >= t.value ? 1.2 : -1.2;
            plaus += s.value >= v.value ? 1.2 : -1.2;
            plaus += t.value >= v.value ? 0.55 : -0.25;
            // Avoid pathological tiny satin when alternatives exist.
            plaus += s.value >= 1000 ? 0.2 : -0.3;
            const iconScore = s.score + t.score + v.score;
            const metric = iconScore * 10 + plaus * 6;
            if (metric > bestMetric) {
              bestMetric = metric;
              bestCombo = { s, t, v };
            }
          }
        }
      }
      if (bestCombo) {
        out.satin = bestCombo.s.value;
        out.gildedThreads = bestCombo.t.value;
        out.artisansVision = bestCombo.v.value;
      }
    }
  }

  return { ...out, __minAssignmentScore: minAssignmentScore, __perKeyScores: perKey };
}

async function extractGovResourcesFromBackpackImage(buffer) {
  const extracted = { satin: null, gildedThreads: null, artisansVision: null };

  // -1) Icon templates in img/gov-resources + full-image word boxes (same OCR family as `/imagerawocr`).
  const fromIcons = await extractGovResourcesByIconMatch(buffer);
  if (Number.isFinite(fromIcons.satin)) extracted.satin = fromIcons.satin;
  if (Number.isFinite(fromIcons.gildedThreads)) extracted.gildedThreads = fromIcons.gildedThreads;
  if (Number.isFinite(fromIcons.artisansVision)) extracted.artisansVision = fromIcons.artisansVision;

  if (
    Number.isFinite(extracted.satin) &&
    Number.isFinite(extracted.gildedThreads) &&
    Number.isFinite(extracted.artisansVision)
  ) {
    return extracted;
  }

  // 0) Geometry fallback: OCR word boxes near legacy anchor positions (only fills missing slots).
  const fromSlots = await extractGovResourcesByNearestWordSlots(buffer);
  if (!Number.isFinite(extracted.satin) && Number.isFinite(fromSlots.satin)) {
    extracted.satin = fromSlots.satin;
  }
  if (!Number.isFinite(extracted.gildedThreads) && Number.isFinite(fromSlots.gildedThreads)) {
    extracted.gildedThreads = fromSlots.gildedThreads;
  }
  if (!Number.isFinite(extracted.artisansVision) && Number.isFinite(fromSlots.artisansVision)) {
    extracted.artisansVision = fromSlots.artisansVision;
  }

  if (
    Number.isFinite(extracted.satin) &&
    Number.isFinite(extracted.gildedThreads) &&
    Number.isFinite(extracted.artisansVision)
  ) {
    return extracted;
  }

  // 1) Keyword OCR (labels visible). Avoid bare "threads" — it matches unrelated UI text.
  const variants = [
    buffer,
    await sharp(buffer).grayscale().normalize().toBuffer(),
    await sharp(buffer).grayscale().normalize().threshold(150).toBuffer(),
  ];
  for (const variant of variants) {
    const text = await runOcrOnBuffer(variant, { tessedit_pageseg_mode: "6" });
    if (extracted.satin === null) {
      extracted.satin = extractValueByKeywords(text, ["satin"]);
    }
    if (extracted.gildedThreads === null) {
      extracted.gildedThreads = extractValueByKeywords(text, ["gilded threads", "gildedthread"]);
    }
    if (extracted.artisansVision === null) {
      extracted.artisansVision = extractValueByKeywords(text, [
        "artisan's vision",
        "artisans vision",
        "artisan vision",
      ]);
    }
    if (
      extracted.satin !== null &&
      extracted.gildedThreads !== null &&
      extracted.artisansVision !== null
    ) {
      break;
    }
  }

  // 2) Grid fallback for backpack screenshots with icon tiles + numbers (no labels shown).
  if (
    extracted.satin === null ||
    extracted.gildedThreads === null ||
    extracted.artisansVision === null
  ) {
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height) {
      // For backpack OCR we intentionally use full-image normalized coordinates.
      // gameplay-bounds detection can shift this UI and miss item number rows.
      const bounds = { left: 0, top: 0, width: meta.width, height: meta.height };
      // Tuned to the standard backpack grid screenshot (4 columns).
      const refW = 368;
      const refH = 782;
      const numberRects = {
        // Ticket icon (Satin) count strip
        satin: { left: 22, top: 297, width: 92, height: 36 },
        // Spool icon (Gilded Threads) count strip
        gildedThreads: { left: 104, top: 387, width: 102, height: 38 },
        // Scroll icon (Artisan's Vision) count strip
        artisansVision: { left: 191, top: 387, width: 102, height: 38 },
      };

      for (const [k, baseRect] of Object.entries(numberRects)) {
        if (Number.isFinite(extracted[k])) continue;
        const scaled = makeRectInBounds(baseRect, bounds, refW, refH, meta.width, meta.height);
        extracted[k] = await ocrNumberFromRegion(buffer, scaled);
      }
    }
  }

  // 3) Smart fallback: full-image OCR with bounding boxes, then map by backpack number-grid position.
  if (
    extracted.satin === null ||
    extracted.gildedThreads === null ||
    extracted.artisansVision === null
  ) {
    const fromGrid = await extractGovResourcesByOcrGrid(buffer);
    if (extracted.satin === null && Number.isFinite(fromGrid.satin)) {
      extracted.satin = fromGrid.satin;
    }
    if (extracted.gildedThreads === null && Number.isFinite(fromGrid.gildedThreads)) {
      extracted.gildedThreads = fromGrid.gildedThreads;
    }
    if (extracted.artisansVision === null && Number.isFinite(fromGrid.artisansVision)) {
      extracted.artisansVision = fromGrid.artisansVision;
    }
  }

  return extracted;
}

async function extractGovResourcesByOcrGrid(buffer) {
  const empty = { satin: null, gildedThreads: null, artisansVision: null };
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return empty;
  const imageW = meta.width;
  const imageH = meta.height;

  const variants = [
    buffer,
    await sharp(buffer).grayscale().normalize().toBuffer(),
    await sharp(buffer).grayscale().normalize().sharpen().toBuffer(),
    await sharp(buffer).grayscale().normalize().threshold(150).toBuffer(),
  ];

  /** @type {{score: number; values: {satin:number|null;gildedThreads:number|null;artisansVision:number|null}} | null} */
  let best = null;

  for (const variant of variants) {
    const data = await runOcrDetailedOnBuffer(variant, {
      tessedit_pageseg_mode: "11", // sparse text; good for inventory grids
      tessedit_char_whitelist: "0123456789,.",
    });
    const words = Array.isArray(data?.words) ? data.words : [];
    const nums = [];
    for (const w of words) {
      const cleaned = normalizeOcrNumberToken(w?.text || "");
      if (!cleaned) continue;
      const parsed = parseInventoryCountToken(cleaned);
      if (!Number.isFinite(parsed)) continue;
      const b = w?.bbox;
      if (!b) continue;
      const x0 = Number(b.x0 ?? 0);
      const y0 = Number(b.y0 ?? 0);
      const x1 = Number(b.x1 ?? x0);
      const y1 = Number(b.y1 ?? y0);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      // Restrict to backpack grid area (skip top bar/nav and bottom buttons).
      if (cx < imageW * 0.06 || cx > imageW * 0.94) continue;
      if (cy < imageH * 0.22 || cy > imageH * 0.90) continue;
      const conf = Number(w?.confidence ?? w?.conf ?? 0) || 0;
      nums.push({ value: parsed, cx, cy, conf });
    }
    if (nums.length < 8) continue;

    nums.sort((a, b) => a.cy - b.cy);
    const rowTol = Math.max(10, Math.round(imageH * 0.022));
    const rows = [];
    for (const n of nums) {
      const last = rows[rows.length - 1];
      if (!last || Math.abs(last.cy - n.cy) > rowTol) {
        rows.push({ cy: n.cy, items: [n] });
      } else {
        const count = last.items.length;
        last.cy = (last.cy * count + n.cy) / (count + 1);
        last.items.push(n);
      }
    }
    const usableRows = rows
      .map((r) => ({
        items: r.items.sort((a, b) => a.cx - b.cx),
      }))
      .filter((r) => r.items.length >= 3);
    if (!usableRows.length) continue;

    let satinRow = null;
    let nextRow = null;
    if (usableRows.length >= 3) {
      satinRow = usableRows[1];
      nextRow = usableRows[2];
    } else if (usableRows.length >= 2) {
      satinRow = usableRows[0];
      nextRow = usableRows[1];
    }
    if (!satinRow || !nextRow) continue;

    const satinVal = satinRow.items[0]?.value ?? null;
    const threadsVal = nextRow.items[1]?.value ?? null;
    const artisanVal = nextRow.items[2]?.value ?? null;
    const score =
      Number(Number.isFinite(satinVal)) +
      Number(Number.isFinite(threadsVal)) +
      Number(Number.isFinite(artisanVal)) +
      Math.max(0, (satinRow.items[0]?.conf || 0) / 100) +
      Math.max(0, (nextRow.items[1]?.conf || 0) / 100) +
      Math.max(0, (nextRow.items[2]?.conf || 0) / 100);

    const values = {
      satin: Number.isFinite(satinVal) ? satinVal : null,
      gildedThreads: Number.isFinite(threadsVal) ? threadsVal : null,
      artisansVision: Number.isFinite(artisanVal) ? artisanVal : null,
    };
    if (!best || score > best.score) best = { score, values };
  }

  return best?.values || empty;
}

async function ocrNumberFromRegion(buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const imageW = meta.width || rect.left + rect.width;
  const imageH = meta.height || rect.top + rect.height;
  const dx = Math.max(2, Math.round(rect.width * 0.22));
  const dy = Math.max(2, Math.round(rect.height * 0.32));
  const candidates = [
    rect,
    clampRect(
      { left: rect.left - dx, top: rect.top, width: rect.width + dx * 2, height: rect.height },
      imageW,
      imageH
    ),
    clampRect(
      { left: rect.left, top: rect.top - dy, width: rect.width, height: rect.height + dy * 2 },
      imageW,
      imageH
    ),
    clampRect(
      {
        left: rect.left - Math.round(dx * 0.5),
        top: rect.top - Math.round(dy * 0.5),
        width: rect.width + dx,
        height: rect.height + dy,
      },
      imageW,
      imageH
    ),
  ];
  const attempts = [
    { scale: 4, threshold: null, psm: "7" },
    { scale: 5, threshold: null, psm: "7" },
    { scale: 6, threshold: null, psm: "8" },
    { scale: 4, threshold: 125, psm: "7" },
    { scale: 5, threshold: 145, psm: "7" },
    { scale: 6, threshold: 170, psm: "8" },
    { scale: 5, threshold: 100, psm: "6" },
  ];
  /** @type {{value:number, score:number} | null} */
  let best = null;
  for (const c of candidates) {
    for (const a of attempts) {
      let pipeline = sharp(buffer)
        .extract(c)
        .resize({
          width: Math.max(12, c.width * a.scale),
          height: Math.max(12, c.height * a.scale),
          kernel: sharp.kernel.nearest,
        })
        .grayscale()
        .normalize()
        .sharpen();
      if (Number.isFinite(a.threshold)) {
        pipeline = pipeline.threshold(a.threshold);
      }
      const crop = await pipeline.toBuffer();
      const text = await runOcrOnBuffer(crop, {
        tessedit_pageseg_mode: a.psm,
        tessedit_char_whitelist: "0123456789,.",
      });
      const parsed = extractBestNumberFromText(text);
      if (!Number.isFinite(parsed)) continue;
      const score =
        String(parsed).length * 10 + Math.min(6, Math.floor(Math.log10(Number(parsed) + 1)));
      if (!best || score > best.score || (score === best.score && parsed > best.value)) {
        best = { value: parsed, score };
      }
    }
  }
  return best ? best.value : null;
}

function parseGovGearOverride(interaction, name) {
  const val = interaction.options.getInteger(name, false);
  if (val === null || val === undefined) return null;
  return Math.max(0, Number(val));
}

function parseGovGearLabelOverride(interaction, name) {
  const raw = interaction.options.getString(name, false);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized in governorGearStepLookup) {
    return governorGearStepLookup[normalized];
  }
  if (/^\d+$/.test(raw.trim())) {
    return Math.max(0, Number(raw.trim()));
  }
  return null;
}

function buildGovGearPayload(parsed) {
  return {
    pieceLevels: {
      [governorGearPieceKeys.infantry1]: parsed.pieceLevels.infantry1,
      [governorGearPieceKeys.infantry2]: parsed.pieceLevels.infantry2,
      [governorGearPieceKeys.cavalry1]: parsed.pieceLevels.cavalry1,
      [governorGearPieceKeys.cavalry2]: parsed.pieceLevels.cavalry2,
      [governorGearPieceKeys.archery1]: parsed.pieceLevels.archery1,
      [governorGearPieceKeys.archery2]: parsed.pieceLevels.archery2,
    },
    resources: {
      satin: parsed.resources.satin,
      gildedThreads: parsed.resources.gildedThreads,
      artisansVision: parsed.resources.artisansVision,
    },
    weights: governorGearDefaultWeights,
    goalMode: "weighted_gain",
  };
}

function clampRect(rect, imageW, imageH) {
  const left = Math.max(0, Math.min(imageW - 1, Math.round(rect.left)));
  const top = Math.max(0, Math.min(imageH - 1, Math.round(rect.top)));
  const maxW = Math.max(1, imageW - left);
  const maxH = Math.max(1, imageH - top);
  const width = Math.max(1, Math.min(maxW, Math.round(rect.width)));
  const height = Math.max(1, Math.min(maxH, Math.round(rect.height)));
  return { left, top, width, height };
}

function makeRectInBounds(baseRect, bounds, refW, refH, imageW, imageH) {
  const scaled = {
    left: bounds.left + (baseRect.left / refW) * bounds.width,
    top: bounds.top + (baseRect.top / refH) * bounds.height,
    width: (baseRect.width / refW) * bounds.width,
    height: (baseRect.height / refH) * bounds.height,
  };
  return clampRect(scaled, imageW, imageH);
}

async function detectGameplayBounds(buffer) {
  const { data, info } = await sharp(buffer).grayscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  if (!w || !h) return null;

  const minBright = 14;
  const minRowHits = Math.max(8, Math.floor(w * 0.06));
  const minColHits = Math.max(8, Math.floor(h * 0.06));
  const step = 2;

  const rowHits = new Array(h).fill(0);
  const colHits = new Array(w).fill(0);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const v = data[y * w + x];
      if (v > minBright) {
        rowHits[y] += 1;
        colHits[x] += 1;
      }
    }
  }

  let top = 0;
  while (top < h && rowHits[top] < minRowHits) top += 1;
  let bottom = h - 1;
  while (bottom > top && rowHits[bottom] < minRowHits) bottom -= 1;
  let left = 0;
  while (left < w && colHits[left] < minColHits) left += 1;
  let right = w - 1;
  while (right > left && colHits[right] < minColHits) right -= 1;

  if (right - left < Math.floor(w * 0.35) || bottom - top < Math.floor(h * 0.35)) {
    return { left: 0, top: 0, width: w, height: h };
  }

  const padX = Math.round((right - left + 1) * 0.02);
  const padY = Math.round((bottom - top + 1) * 0.02);
  return clampRect(
    {
      left: left - padX,
      top: top - padY,
      width: right - left + 1 + padX * 2,
      height: bottom - top + 1 + padY * 2,
    },
    w,
    h
  );
}

// Governor profile gear layout (reference portrait ~368x782), scaled via gameplay bounds.
// qualityRects: rough ROIs — `refineGearSlotRectToFrame` recenters on the actual warm/red gear frame per screenshot.
const GOV_GEAR_REF_LAYOUT = {
  refW: 368,
  refH: 782,
  qualityRects: {
    cavalry1: { left: 8, top: 118, width: 102, height: 124 },
    cavalry2: { left: 198, top: 118, width: 128, height: 124 },
    infantry1: { left: 8, top: 246, width: 102, height: 124 },
    infantry2: { left: 198, top: 246, width: 128, height: 124 },
    archery1: { left: 8, top: 374, width: 102, height: 124 },
    archery2: { left: 198, top: 374, width: 128, height: 124 },
  },
};

/** Fractional shifts of each slot rect (relative to slot width/height) for template multi-crop. */
const GOV_GEAR_TEMPLATE_MICRO_SHIFTS = [
  { x: 0, y: 0 },
  { x: -0.045, y: 0 },
  { x: 0.045, y: 0 },
  { x: 0, y: -0.045 },
  { x: 0, y: 0.045 },
];

/** @type {Promise<unknown> | undefined} */
let govGearTemplateBankPromise;

const govGearRefineCropsEnabled =
  String(process.env.GOV_GEAR_REFINE_CROPS || "true").toLowerCase() !== "false";

/**
 * Re-center a slot crop on the warm / reddish gear frame inside a padded search window.
 * Fixes misalignment when aspect ratio or safe-area shifts the UI vs fixed 368×782 calibration.
 * @param {Buffer} buffer
 * @param {{ left: number; top: number; width: number; height: number }} rect
 * @param {number} imageW
 * @param {number} imageH
 */
async function refineGearSlotRectToFrame(buffer, rect, imageW, imageH) {
  const pad = Math.max(10, Math.round(0.42 * Math.max(rect.width, rect.height)));
  const search = clampRect(
    {
      left: rect.left - pad,
      top: rect.top - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    },
    imageW,
    imageH
  );
  const rw = 52;
  const rh = 52;
  let raw;
  try {
    raw = await sharp(buffer)
      .extract(search)
      .resize(rw, rh, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch {
    return rect;
  }
  const { data, info } = raw;
  const w = info.width;
  const h = info.height;
  const ch = info.channels || 3;
  const step = ch >= 4 ? 4 : 3;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * step;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx - mn;
      const warm = r > 88 && r >= g - 22 && r >= b - 22 && r + g + b > 145;
      if (!warm || sat < 12) continue;
      hits += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (hits < 12 || bw < 4 || bh < 4 || bw > w * 0.92 || bh > h * 0.92) {
    return rect;
  }
  let cx = ((minX + maxX) / 2 / w) * search.width + search.left;
  let cy = ((minY + maxY) / 2 / h) * search.height + search.top;
  // Icon art sits slightly below the warm frame centroid — small downward bias.
  cy += rect.height * 0.055;
  return clampRect(
    {
      left: cx - rect.width / 2,
      top: cy - rect.height / 2,
      width: rect.width,
      height: rect.height,
    },
    imageW,
    imageH
  );
}

/**
 * Crops each gear slot icon region for template matching / training.
 * @param {Buffer} gearBuffer
 * @param {"detected" | "full"} boundsMode — `full` uses the entire image as layout bounds (helps when auto-detected bounds skew crops on some phones).
 * @param {{ x?: number; y?: number }} shiftFrac — nudge crop in fractions of the slot rect (multi-crop matching).
 */
async function extractGovGearSlotCrops(gearBuffer, boundsMode = "detected", shiftFrac = {}) {
  const gearMeta = await sharp(gearBuffer).metadata();
  if (!gearMeta.width || !gearMeta.height) return null;
  const { refW, refH, qualityRects } = GOV_GEAR_REF_LAYOUT;
  const gearBounds =
    boundsMode === "full"
      ? { left: 0, top: 0, width: gearMeta.width, height: gearMeta.height }
      : (await detectGameplayBounds(gearBuffer)) || {
          left: 0,
          top: 0,
          width: gearMeta.width,
          height: gearMeta.height,
        };
  const sx = Number(shiftFrac?.x) || 0;
  const sy = Number(shiftFrac?.y) || 0;
  /** @type {Record<string, Buffer>} */
  const crops = {};
  for (const [k, qualityRect] of Object.entries(qualityRects)) {
    const scaled = makeRectInBounds(
      qualityRect,
      gearBounds,
      refW,
      refH,
      gearMeta.width,
      gearMeta.height
    );
    let rect = clampRect(
      {
        left: scaled.left + sx * scaled.width,
        top: scaled.top + sy * scaled.height,
        width: scaled.width,
        height: scaled.height,
      },
      gearMeta.width,
      gearMeta.height
    );
    if (govGearRefineCropsEnabled) {
      rect = await refineGearSlotRectToFrame(gearBuffer, rect, gearMeta.width, gearMeta.height);
    }
    crops[k] = await sharp(gearBuffer).extract(rect).png().toBuffer();
  }
  return crops;
}

const GOV_GEAR_DEBUG_FILENAME = "gov-gear-slot-crops-debug.png";

const GOV_GEAR_DEBUG_SLOTS = [
  { key: "cavalry1", short: "Cav1" },
  { key: "cavalry2", short: "Cav2" },
  { key: "infantry1", short: "Inf1" },
  { key: "infantry2", short: "Inf2" },
  { key: "archery1", short: "Arc1" },
  { key: "archery2", short: "Arc2" },
];

function escapeXmlForSvg(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One labeled 2×3 panel of slot crops (same order as in-game: left column / right column).
 * @param {Record<string, Buffer>} crops
 * @param {string} title
 */
async function renderGovGearCropStrip(crops, title) {
  for (const { key } of GOV_GEAR_DEBUG_SLOTS) {
    if (!crops[key]) return null;
  }
  const thumb = 96;
  const labelH = 22;
  const gap = 10;
  const cols = 2;
  const rows = 3;
  const titleH = 30;
  const cellW = thumb;
  const cellH = labelH + thumb;
  const gridW = cols * cellW + (cols + 1) * gap;
  const gridH = rows * cellH + (rows + 1) * gap;
  const width = gridW;
  const height = titleH + gridH + gap;
  const titleSvg = Buffer.from(
    `<svg width="${width}" height="${titleH}"><rect width="100%" height="100%" fill="#2b2d31"/><text x="50%" y="20" text-anchor="middle" fill="#f2f3f5" font-size="13" font-family="Arial,sans-serif">${escapeXmlForSvg(
      title
    )}</text></svg>`
  );
  /** @type {{ input: Buffer; left: number; top: number }[]} */
  const layers = [{ input: titleSvg, left: 0, top: 0 }];
  for (let i = 0; i < GOV_GEAR_DEBUG_SLOTS.length; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const left = gap + c * (cellW + gap);
    const top = titleH + gap + r * (cellH + gap);
    const { key, short } = GOV_GEAR_DEBUG_SLOTS[i];
    const labelSvg = Buffer.from(
      `<svg width="${cellW}" height="${labelH}"><rect width="100%" height="100%" fill="#232428"/><text x="50%" y="15" text-anchor="middle" fill="#b5bac1" font-size="12" font-family="Arial,sans-serif">${escapeXmlForSvg(
        short
      )}</text></svg>`
    );
    const thumbBuf = await sharp(crops[key])
      .resize(thumb, thumb, {
        fit: "contain",
        background: { r: 46, g: 48, b: 54 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    layers.push({ input: labelSvg, left, top });
    layers.push({ input: thumbBuf, left, top: top + labelH });
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 18, g: 19, b: 22 } },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * Stacked PNG: crops with auto-detected bounds vs full-frame bounds (zero shift).
 * @param {Buffer} gearBuffer
 */
async function buildGovGearCropDebugSheet(gearBuffer) {
  const cDet = await extractGovGearSlotCrops(gearBuffer, "detected", { x: 0, y: 0 });
  const cFull = await extractGovGearSlotCrops(gearBuffer, "full", { x: 0, y: 0 });
  if (!cDet || !cFull) return null;
  const stripDet = await renderGovGearCropStrip(
    cDet,
    "Detected UI bounds (same cropper as Kingshot-image training)"
  );
  const stripFull = await renderGovGearCropStrip(
    cFull,
    "Full image bounds (used as match fallback)"
  );
  if (!stripDet || !stripFull) return null;
  const m1 = await sharp(stripDet).metadata();
  const m2 = await sharp(stripFull).metadata();
  const w = Math.max(m1.width || 0, m2.width || 0);
  const h1 = m1.height || 0;
  const h2 = m2.height || 0;
  const spacer = 14;
  const totalH = h1 + spacer + h2;
  return sharp({
    create: { width: w, height: totalH, channels: 3, background: { r: 16, g: 17, b: 20 } },
  })
    .composite([
      { input: stripDet, left: 0, top: 0 },
      { input: stripFull, left: 0, top: h1 + spacer },
    ])
    .png()
    .toBuffer();
}

async function getGovGearTemplateBank() {
  if (govGearTemplateBankPromise === undefined) {
    govGearTemplateBankPromise = loadGovGearTemplateBank(
      govGearTemplateDir,
      governorGearStepLookup,
      (buf) => extractGovGearSlotCrops(buf, "detected", { x: 0, y: 0 })
    ).catch((err) => {
      console.warn("Governor gear template bank failed to load:", err?.message || err);
      return null;
    });
  }
  return govGearTemplateBankPromise;
}

function summarizeGovGearRecommendations(recommendations, max = 8) {
  if (!Array.isArray(recommendations) || !recommendations.length) return "No upgrades recommended.";
  const lines = recommendations.slice(0, max).map((r, idx) => {
    const pieceName = r?.piece?.name || r?.piece?.id || "Unknown piece";
    const from = Number.isFinite(Number(r?.fromStep)) ? r.fromStep : "?";
    const to = Number.isFinite(Number(r?.toStep)) ? r.toStep : "?";
    const cost = r?.resourceCost || {};
    return `${idx + 1}. ${pieceName}: ${from} -> ${to} | +${Number(r?.statGain || 0).toFixed(2)} stat | S:${cost.satin ?? 0} GT:${cost.gildedThreads ?? 0} AV:${cost.artisansVision ?? 0}`;
  });
  return lines.join("\n");
}

function buildGovGearPreviewEmbed(parsed, meta = {}) {
  const gearHint =
    meta.gearSource === "template"
      ? "Gear levels: matched from your `Kingshot-image` reference set (visual fingerprint + ring color histogram)."
      : meta.gearSource === "partial"
        ? "Gear levels: some slots matched references; others use slash overrides or need clearer photos / more labeled examples in `Kingshot-image`."
        : "Gear levels: from slash command overrides and/or template matching (see similarity scores).";
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Governor Gear — preview")
    .setDescription(
      "Please confirm extracted values before optimization.\n" +
        "Resources come from command input and/or backpack OCR.\n" +
        gearHint
    )
    .addFields(
      {
        name: "Resources",
        value:
          `Satin: ${parsed.resources.satin}\n` +
          `Gilded Threads: ${parsed.resources.gildedThreads}\n` +
          `Artisan's Vision: ${parsed.resources.artisansVision}`,
        inline: true,
      },
      {
        name: "Gear Levels",
        value:
          `Inf1: ${formatGovGearStep(parsed.pieceLevels.infantry1)} (${parsed.pieceLevels.infantry1})\n` +
          `Inf2: ${formatGovGearStep(parsed.pieceLevels.infantry2)} (${parsed.pieceLevels.infantry2})\n` +
          `Cav1: ${formatGovGearStep(parsed.pieceLevels.cavalry1)} (${parsed.pieceLevels.cavalry1})\n` +
          `Cav2: ${formatGovGearStep(parsed.pieceLevels.cavalry2)} (${parsed.pieceLevels.cavalry2})\n` +
          `Arc1: ${formatGovGearStep(parsed.pieceLevels.archery1)} (${parsed.pieceLevels.archery1})\n` +
          `Arc2: ${formatGovGearStep(parsed.pieceLevels.archery2)} (${parsed.pieceLevels.archery2})`,
        inline: true,
      }
    );
  if (meta.templateScores && typeof meta.templateScores === "object") {
    const order = [
      "infantry1",
      "infantry2",
      "cavalry1",
      "cavalry2",
      "archery1",
      "archery2",
    ];
    const short = {
      infantry1: "Inf1",
      infantry2: "Inf2",
      cavalry1: "Cav1",
      cavalry2: "Cav2",
      archery1: "Arc1",
      archery2: "Arc2",
    };
    const lines = order.map((k) => {
      const sc = meta.templateScores[k];
      const s = sc === -1 ? "—" : Number.isFinite(sc) ? sc.toFixed(3) : "?";
      return `${short[k]}:${s}`;
    });
    embed.addFields({
      name: "Template match (cosine, higher = closer)",
      value: lines.join("  ").slice(0, 1020),
      inline: false,
    });
  }
  const footerText = meta.showCropsAttachment
    ? "Press Confirm to run optimizer API • Large image below = 6 slot crops (detected bounds, then full-frame bounds)."
    : "Press Confirm to run optimizer API";
  return embed.setFooter({ text: footerText });
}

function buildPlayerEmbed(d, fallbackId) {
  const embed = new EmbedBuilder()
    .setColor(0xc9a227)
    .setTitle(d.name || "Player")
    .addFields(
      { name: "Player ID", value: String(d.playerId ?? fallbackId), inline: true },
      { name: "Kingdom", value: String(d.kingdom ?? "—"), inline: true },
      {
        name: "Level",
        value: d.levelRenderedDetailed || `Level ${d.level ?? "?"}`,
        inline: true,
      }
    )
    .setFooter({
      text: "Level from kingshot.net API (main account progression).",
    });

  if (d.profilePhoto && /^https?:\/\//i.test(d.profilePhoto)) {
    embed.setThumbnail(d.profilePhoto);
  }
  if (d.levelImage && /^https?:\/\//i.test(d.levelImage)) {
    embed.setImage(d.levelImage);
  }
  return embed;
}

function buildKvkMatchesEmbeds(matches, options, pagination) {
  const sortedMatches = [...matches].sort((a, b) => {
    const seasonDiff = Number(b.season_id ?? 0) - Number(a.season_id ?? 0);
    if (seasonDiff !== 0) return seasonDiff;
    return Number(b.kvk_id ?? 0) - Number(a.kvk_id ?? 0);
  });

  const cards = sortedMatches.map((m, idx) => {
    const castleWinner =
      Number.isFinite(Number(m.castle_winner)) && Number(m.castle_winner) > 0
        ? `#${m.castle_winner}`
        : "Unknown";
    const prepWinner =
      Number.isFinite(Number(m.prep_winner)) && Number(m.prep_winner) > 0
        ? `#${m.prep_winner}`
        : "Unknown";
    const season = m.kvk_title || `Season #${m.season_id ?? "?"}`;
    const captured = m.castle_captured ? "Captured" : "Not Captured";

    let perspective = "UNKNOWN";
    if (Number.isFinite(Number(options.kingdomId))) {
      const k = Number(options.kingdomId);
      if (Number(m.castle_winner) === k) perspective = "WIN";
      else if (Number(m.kingdom_a) === k || Number(m.kingdom_b) === k) perspective = "LOSS";
    }

    const resultBadge =
      perspective === "WIN" ? "🟢 WIN" : perspective === "LOSS" ? "🔴 LOSS" : "⚪ UNKNOWN";
    const titlePrefix = idx % 3 === 0 ? "" : "│ ";
    const linePrefix = idx % 3 === 0 ? "" : "│ ";
    const valueLines = [
      `⚔️ #${m.kingdom_a} vs #${m.kingdom_b}`,
      `🥇 Prep: ${prepWinner}`,
      `👑 Castle: ${castleWinner}`,
      `${resultBadge}`,
    ].map((line) => `${linePrefix}${line}`);
    return {
      name: `${titlePrefix}${idx + 1}) ${season}`,
      value: valueLines.join("\n"),
    };
  });

  const total = sortedMatches.length;
  const kingdom = Number(options.kingdomId);
  const wins = sortedMatches.filter((m) => Number(m.castle_winner) === kingdom).length;
  const losses = sortedMatches.filter(
    (m) =>
      (Number(m.kingdom_a) === kingdom || Number(m.kingdom_b) === kingdom) &&
      Number(m.castle_winner) !== kingdom
  ).length;
  const winRate = total ? Math.round((wins / total) * 100) : 0;

  const CARDS_PER_EMBED = 12;
  const chunks = [];
  for (let i = 0; i < cards.length; i += CARDS_PER_EMBED) {
    chunks.push(cards.slice(i, i + CARDS_PER_EMBED));
  }

  const maxEmbeds = 10;
  const limitedChunks = chunks.slice(0, maxEmbeds);
  const truncated = chunks.length > maxEmbeds;
  const embeds = limitedChunks.map((chunkCards, idx) => {
    const titleSuffix = limitedChunks.length > 1 ? ` (Part ${idx + 1}/${limitedChunks.length})` : "";
    const summary = `📊 **Summary** • Matches: **${total}** • Wins: **${wins}** • Losses: **${losses}** • Win Rate: **${winRate}%**`;
    const embed = new EmbedBuilder()
      .setColor(wins >= losses ? 0x2ecc71 : 0xe67e22)
      .setTitle(`Kingshot KVK Matches (${total})${titleSuffix}`)
      .setDescription(idx === 0 ? summary : "More records:")
      .setFooter({ text: "Source: kingshot.net/api/kvk/matches" });

    if (idx === 0 && options.kingdomId !== undefined) {
      embed.addFields({ name: "Kingdom", value: `#${options.kingdomId}`, inline: false });
    }
    if (idx === 0 && pagination && pagination.total !== undefined) {
      embed.addFields({
        name: "Pagination",
        value: `Page ${pagination.page ?? 1} / ${pagination.totalPages ?? "?"} (total ${pagination.total})`,
        inline: true,
      });
    }
    const fields = [];
    for (let i = 0; i < chunkCards.length; i++) {
      fields.push({ name: chunkCards[i].name, value: chunkCards[i].value, inline: true });
      const isEndOfRow = (i + 1) % 3 === 0;
      const hasMore = i < chunkCards.length - 1;
      if (isEndOfRow && hasMore) {
        fields.push({
          name: "\u200b",
          value: "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          inline: false,
        });
      }
    }

    embed.addFields(fields);
    return embed;
  });

  if (truncated && embeds.length) {
    const last = embeds[embeds.length - 1];
    last.addFields({
      name: "Note",
      value: "Too many records to display in one message. Showing first pages of results.",
      inline: false,
    });
  }
  return embeds;
}

function formatMonthsDaysFromDate(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "Unknown";

  const now = new Date();
  let years = now.getUTCFullYear() - d.getUTCFullYear();
  let months = now.getUTCMonth() - d.getUTCMonth();
  let days = now.getUTCDate() - d.getUTCDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
    days += prevMonth;
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalMonths = Math.max(0, years * 12 + months);
  return `${totalMonths} חודשים, ${Math.max(days, 0)} ימים`;
}

function formatOpenDate(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

async function replyWithKingdomAge(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);
  await interaction.deferReply();

  const result = await fetchKingdomTrackerById(kingdomId);
  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    return;
  }

  const k = result.data;
  const pazam = formatMonthsDaysFromDate(k.openTime);
  const openTime = formatOpenDate(k.openTime);

  const embed = applyBrandThumbnail(
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`פז\"מ של השרת #${k.kingdomId}`)
      .setDescription(`🕒 ${pazam}\n📅 ${openTime}`)
      .setFooter({ text: "Source: kingshot.net/api/kingdom-tracker" })
  );

  await interaction.editReply(buildEmbedReplyPayload([embed]));
}

/**
 * @param {number} kingdomId
 * @returns {Promise<{ ok: true, embed: import('discord.js').EmbedBuilder } | { ok: false, message: string }>}
 */
async function buildKingdomAgeEmbed(kingdomId) {
  const result = await fetchKingdomTrackerById(kingdomId);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const k = result.data;
  const pazam = formatMonthsDaysFromDate(k.openTime);
  const openTime = formatOpenDate(k.openTime);

  const embed = applyBrandThumbnail(
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`פז\"מ של השרת #${k.kingdomId}`)
      .setDescription(`${pazam} 🕒\n${openTime} 📅`)
      .setFooter({ text: "Source: kingshot.net/api/kingdom-tracker" })
  );

  return { ok: true, embed };
}

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {string} rawId
 */
async function replyWithPlayerLookup(interaction, rawId) {
  const trimmed = String(rawId).trim();
  if (!/^\d+$/.test(trimmed)) {
    const msg = "Player ID must be numbers only (example: `8767319`).";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  await interaction.deferReply();

  const result = await fetchPlayerInfo(trimmed);
  if (!result.ok) {
    await interaction.editReply({
      content: result.message,
    });
    return;
  }

  await interaction.editReply({
    embeds: [buildPlayerEmbed(result.data, trimmed)],
  });
}

/**
 * @param {import('discord.js').Interaction} interaction
 */
async function replyWithKvkMatches(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);

  await interaction.deferReply();

  const result = await fetchKvkMatchesForKingdom({ kingdomId });
  if (!result.ok) {
    await interaction.editReply({ content: result.message });
    return;
  }

  if (!result.data.length) {
    await interaction.editReply({ content: `No KvK matches found for kingdom #${kingdomId}.` });
    return;
  }

  await interaction.editReply({
    embeds: buildKvkMatchesEmbeds(result.data, { kingdomId }, null),
  });
}

/**
 * @param {import('discord.js').Interaction} interaction
 */
function formatGovResourceCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "Not detected";
  }
  return Number(value).toLocaleString("en-US");
}

function getResourceIconRectFromAssignment(layout, assignment) {
  const { content, cellW, cellH, imageW, imageH } = layout;
  const { r, c } = assignment;
  const cellLeft = content.left + c * cellW;
  const cellTop = content.top + r * cellH;
  const mx = cellW * 0.05;
  const my = cellH * 0.04;
  return clampRect(
    {
      left: cellLeft + mx,
      top: cellTop + my,
      width: cellW - mx * 2,
      height: cellH * 0.64,
    },
    imageW,
    imageH
  );
}

function getResourceIconRectFromCell(layout, r, c) {
  const { content, cellW, cellH, imageW, imageH } = layout;
  const cellLeft = content.left + c * cellW;
  const cellTop = content.top + r * cellH;
  const mx = cellW * 0.05;
  const my = cellH * 0.04;
  return clampRect(
    {
      left: cellLeft + mx,
      top: cellTop + my,
      width: cellW - mx * 2,
      height: cellH * 0.64,
    },
    imageW,
    imageH
  );
}

function getResourceCellRectFromAssignment(layout, assignment) {
  const { content, cellW, cellH, imageW, imageH } = layout;
  const { r, c } = assignment;
  const cellLeft = content.left + c * cellW;
  const cellTop = content.top + r * cellH;
  return clampRect(
    {
      left: cellLeft + cellW * 0.01,
      top: cellTop + cellH * 0.01,
      width: cellW * 0.98,
      height: cellH * 0.98,
    },
    imageW,
    imageH
  );
}

function expandRect(rect, imageW, imageH, padXFrac = 0.08, padYFrac = 0.28) {
  return clampRect(
    {
      left: rect.left - rect.width * padXFrac,
      top: rect.top - rect.height * padYFrac,
      width: rect.width * (1 + padXFrac * 2),
      height: rect.height * (1 + padYFrac * 2),
    },
    imageW,
    imageH
  );
}

/**
 * Build debug attachments showing icon cell + number strip chosen by icon matcher.
 * @param {Buffer} buffer
 */
async function buildGovResourceDebugAttachments(buffer) {
  const matched = await matchBackpackResourceCells(buffer, {
    templateDir: govResourceIconDir,
    // Debug mode: force a best-effort match so user can inspect what was selected,
    // even when production threshold rejects icon confidence.
    minScore: 0.01,
    gridShiftSweep: true,
  });
  if (!matched) return [];
  const keyOrder = ["satin", "gildedThreads", "artisansVision"];
  const keyTitle = {
    satin: "satin",
    gildedThreads: "gilded-threads",
    artisansVision: "artisans-vision",
  };
  const templateFile = {
    satin: "satin.png",
    gildedThreads: "gilded-threads.png",
    artisansVision: "artisans-vision.png",
  };
  const { assignments, layout } = matched;
  /** @type {import('discord.js').AttachmentBuilder[]} */
  const files = [];
  for (const key of keyOrder) {
    const asg = assignments[key];
    if (!asg) continue;
    const templatePath = path.join(govResourceIconDir, templateFile[key]);
    const cellRect = getResourceCellRectFromAssignment(layout, asg);
    const iconRect = getResourceIconRectFromAssignment(layout, asg);
    const numberRectRaw = numberRectForAssignment(layout, asg);
    const numberRect = expandRect(numberRectRaw, layout.imageW, layout.imageH, 0.08, 0.35);
    const templateBuf = await sharp(templatePath)
      .resize(160, 110, {
        fit: "contain",
        background: { r: 26, g: 27, b: 30 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    const cellBuf = await sharp(buffer)
      .extract(cellRect)
      .resize(240, 110, {
        fit: "contain",
        background: { r: 26, g: 27, b: 30 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    // Also show icon-only crop for finer inspection.
    const iconBuf = await sharp(buffer)
      .extract(iconRect)
      .resize(120, 110, {
        fit: "contain",
        background: { r: 26, g: 27, b: 30 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    const numberBuf = await sharp(buffer)
      .extract(numberRect)
      .resize(240, 92, {
        fit: "contain",
        background: { r: 26, g: 27, b: 30 },
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    const titleSvg = Buffer.from(
      `<svg width="560" height="34"><rect width="100%" height="100%" fill="#232428"/><text x="10" y="22" fill="#d9dde3" font-size="13" font-family="Arial,sans-serif">${escapeXmlForSvg(
        `${keyTitle[key]} | row ${asg.r + 1}, col ${asg.c + 1}, score ${Number.isFinite(asg.score) ? asg.score.toFixed(3) : "na"}`
      )}</text></svg>`
    );
    const l1 = Buffer.from(
      `<svg width="160" height="20"><text x="4" y="15" fill="#9aa3ad" font-size="12" font-family="Arial,sans-serif">template icon</text></svg>`
    );
    const l2 = Buffer.from(
      `<svg width="240" height="20"><text x="4" y="15" fill="#9aa3ad" font-size="12" font-family="Arial,sans-serif">chosen cell in user photo</text></svg>`
    );
    const l3 = Buffer.from(
      `<svg width="240" height="20"><text x="4" y="15" fill="#9aa3ad" font-size="12" font-family="Arial,sans-serif">OCR number strip</text></svg>`
    );
    const l4 = Buffer.from(
      `<svg width="120" height="20"><text x="4" y="15" fill="#9aa3ad" font-size="12" font-family="Arial,sans-serif">icon-only</text></svg>`
    );
    const panel = await sharp({
      create: { width: 560, height: 278, channels: 3, background: { r: 18, g: 19, b: 22 } },
    })
      .composite([
        { input: titleSvg, left: 0, top: 0 },
        { input: l1, left: 10, top: 44 },
        { input: l2, left: 180, top: 44 },
        { input: l4, left: 430, top: 44 },
        { input: templateBuf, left: 10, top: 64 },
        { input: cellBuf, left: 180, top: 64 },
        { input: iconBuf, left: 430, top: 64 },
        { input: l3, left: 180, top: 186 },
        { input: numberBuf, left: 180, top: 206 },
      ])
      .png()
      .toBuffer();
    const name = `match-${keyTitle[key]}-r${asg.r + 1}-c${asg.c + 1}.png`;
    files.push(new AttachmentBuilder(panel, { name }));
  }
  return files;
}

function scoreToPct(score) {
  if (!Number.isFinite(score)) return "0.0%";
  // Cosine-ish score in [-1,1] -> [0,100] for human-readable debug.
  const pct = ((score + 1) / 2) * 100;
  return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

/**
 * Build a per-cell score report: each crop item and its match % to all templates.
 * @param {Buffer} buffer
 */
async function buildGovResourceCellScoreReportAttachment(buffer) {
  const matched = await matchBackpackResourceCells(buffer, {
    templateDir: govResourceIconDir,
    minScore: 0.01,
    gridShiftSweep: true,
    includeScoreGrid: true,
  });
  const scoreGrid = matched?.scoreGrid;
  const layout = matched?.layout;
  if (!scoreGrid || !layout) return null;

  const lines = [];
  lines.push("Governor resource icon-match report");
  lines.push(`Grid: ${layout.rows} rows x ${layout.cols} cols`);
  lines.push("Percent mapping: (score+1)/2*100");
  lines.push("");
  lines.push("row,col,satin,gilded_threads,artisans_vision,best_key,best_pct");

  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const s = scoreGrid[r][c];
      const entries = [
        { key: "satin", score: s.satin },
        { key: "gilded_threads", score: s.gildedThreads },
        { key: "artisans_vision", score: s.artisansVision },
      ].sort((a, b) => b.score - a.score);
      const best = entries[0];
      lines.push(
        [
          r + 1,
          c + 1,
          scoreToPct(s.satin),
          scoreToPct(s.gildedThreads),
          scoreToPct(s.artisansVision),
          best.key,
          scoreToPct(best.score),
        ].join(",")
      );
    }
  }
  return new AttachmentBuilder(Buffer.from(lines.join("\n") + "\n", "utf8"), {
    name: "gov-resource-cell-match-scores.csv",
  });
}

/**
 * Build a visual sheet of all icon crops + per-template match percentages.
 * @param {Buffer} buffer
 */
async function buildGovResourceCellScoreSheetAttachment(buffer) {
  const matched = await matchBackpackResourceCells(buffer, {
    templateDir: govResourceIconDir,
    minScore: 0.01,
    gridShiftSweep: true,
    includeScoreGrid: true,
  });
  const scoreGrid = matched?.scoreGrid;
  const layout = matched?.layout;
  if (!scoreGrid || !layout) return null;

  const cols = layout.cols;
  const rows = layout.rows;
  const tileW = 170;
  const tileH = 166;
  const gap = 8;
  const headH = 36;
  const sheetW = cols * tileW + (cols + 1) * gap;
  const sheetH = headH + rows * tileH + (rows + 1) * gap;

  /** @type {{ input: Buffer; left: number; top: number }[]} */
  const layers = [];
  const titleSvg = Buffer.from(
    `<svg width="${sheetW}" height="${headH}"><rect width="100%" height="100%" fill="#232428"/><text x="10" y="24" fill="#d9dde3" font-size="14" font-family="Arial,sans-serif">Backpack icon crops with match % to Satin / Threads / Artisan</text></svg>`
  );
  layers.push({ input: titleSvg, left: 0, top: 0 });

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = gap + c * (tileW + gap);
      const y = headH + gap + r * (tileH + gap);
      const iconRect = getResourceIconRectFromCell(layout, r, c);
      const iconBuf = await sharp(buffer)
        .extract(iconRect)
        .resize(tileW - 12, 88, {
          fit: "contain",
          background: { r: 26, g: 27, b: 30 },
          kernel: sharp.kernel.lanczos3,
        })
        .png()
        .toBuffer();
      const s = scoreGrid[r][c];
      const line1 = `r${r + 1} c${c + 1}`;
      const line2 = `Satin ${scoreToPct(s.satin)}`;
      const line3 = `Threads ${scoreToPct(s.gildedThreads)}`;
      const line4 = `Artisan ${scoreToPct(s.artisansVision)}`;
      const label = Buffer.from(
        `<svg width="${tileW}" height="${tileH}"><rect width="100%" height="100%" fill="#17181b"/><text x="8" y="112" fill="#d5d8de" font-size="12" font-family="Arial,sans-serif">${escapeXmlForSvg(
          line1
        )}</text><text x="8" y="128" fill="#8fd3ff" font-size="12" font-family="Arial,sans-serif">${escapeXmlForSvg(
          line2
        )}</text><text x="8" y="144" fill="#c8a0ff" font-size="12" font-family="Arial,sans-serif">${escapeXmlForSvg(
          line3
        )}</text><text x="8" y="160" fill="#ffcc88" font-size="12" font-family="Arial,sans-serif">${escapeXmlForSvg(
          line4
        )}</text></svg>`
      );
      layers.push({ input: label, left: x, top: y });
      layers.push({ input: iconBuf, left: x + 6, top: y + 8 });
    }
  }

  const sheet = await sharp({
    create: { width: sheetW, height: sheetH, channels: 3, background: { r: 12, g: 13, b: 15 } },
  })
    .composite(layers)
    .png()
    .toBuffer();

  return new AttachmentBuilder(sheet, { name: "gov-resource-cell-match-sheet.png" });
}

async function replyWithGovResourcesOcr(interaction) {
  const resourcesImage = interaction.options.getAttachment("resources_image", true);
  await interaction.deferReply();

  try {
    const buffer = await attachmentToBuffer(resourcesImage);
    const extracted = await extractGovResourcesFromBackpackImage(buffer);

    const satinOk = Number.isFinite(extracted.satin);
    const threadsOk = Number.isFinite(extracted.gildedThreads);
    const visionOk = Number.isFinite(extracted.artisansVision);
    const allOk = satinOk && threadsOk && visionOk;
    const anyOk = satinOk || threadsOk || visionOk;

    const scoreSheetFile = await buildGovResourceCellScoreSheetAttachment(buffer);
    const allFiles = scoreSheetFile ? [scoreSheetFile] : [];
    const embed = new EmbedBuilder()
      .setTitle("Governor resources (backpack)")
      .setDescription(
        "Same reading logic as `/govgearopt` when you attach **resources_image** — only these three values."
      )
      .addFields(
        { name: "Satin", value: formatGovResourceCount(extracted.satin), inline: true },
        { name: "Gilded Threads", value: formatGovResourceCount(extracted.gildedThreads), inline: true },
        { name: "Artisan's Vision", value: formatGovResourceCount(extracted.artisansVision), inline: true }
      )
      .setFooter({ text: `OCR_ENGINE=${ocrEngine} · Paddle worker: ${paddleOcrWorkerEnabled ? "on" : "off"}` })
      .setColor(allOk ? 0x2ecc71 : anyOk ? 0xf39c12 : 0xe74c3c);

    if (!allOk) {
      embed.addFields({
        name: "Tip",
        value:
          "Use a clear backpack view with the resource row visible. If labels are in another language, try a similar crop to the reference layout (4 columns).",
        inline: false,
      });
    }
    if (scoreSheetFile) {
      embed.addFields({
        name: "Match sheet",
        value:
          "Attached `gov-resource-cell-match-sheet.png` with each cropped icon cell and its match % to Satin / Threads / Artisan.",
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed], files: allFiles });
  } catch (err) {
    console.error("govresourcesocr failed:", err);
    await interaction.editReply({
      content: "Failed to OCR this image. Try another screenshot.",
    });
  }
}

/**
 * Full-frame OCR dump (same Paddle/Tesseract stack as elsewhere).
 * @param {import('discord.js').Interaction} interaction
 */
async function replyWithImageOcrRaw(interaction) {
  const image = interaction.options.getAttachment("image", true);
  await interaction.deferReply();

  try {
    const buffer = await attachmentToBuffer(image);
    const detailed = await runOcrDetailedOnBuffer(buffer, {
      includeWords: false,
      tessedit_pageseg_mode: "6",
    });
    const raw = String(detailed?.text || "");
    const trimmed = raw.trim();
    const engine = lastOcrEngineUsed;
    const lines = trimmed ? trimmed.split(/\r?\n/).length : 0;

    const embed = new EmbedBuilder()
      .setTitle("Full-page raw OCR")
      .setDescription(
        trimmed.length
          ? `Attached **ocr-raw.txt** (${trimmed.length.toLocaleString("en-US")} characters, ${lines.toLocaleString("en-US")} lines, engine: **${engine}**).`
          : `No text returned by OCR (engine: **${engine}**).`
      )
      .setColor(trimmed.length ? 0x3498db : 0x95a5a6)
      .setFooter({ text: `OCR_ENGINE=${ocrEngine}` });

    /** @type {import('discord.js').AttachmentBuilder[]} */
    const files = [];
    if (trimmed.length) {
      files.push(new AttachmentBuilder(Buffer.from(`${trimmed}\n`, "utf8"), { name: "ocr-raw.txt" }));
    }

    await interaction.editReply({ embeds: [embed], files });
  } catch (err) {
    console.error("imagerawocr failed:", err);
    await interaction.editReply({
      content: "Failed to OCR this image. Try another file or format.",
    });
  }
}

/**
 * @param {import('discord.js').Interaction} interaction
 */
async function replyWithGovGearOptimization(interaction) {
  const gearImage = interaction.options.getAttachment("gear_image", true);
  const satin = interaction.options.getInteger("satin", false);
  const gildedThreads = interaction.options.getInteger("gilded_threads", false);
  const artisansVision = interaction.options.getInteger("artisans_vision", false);
  const showCrops = interaction.options.getBoolean("show_crops") === true;

  await interaction.deferReply();

  try {
    const gearBuffer = await attachmentToBuffer(gearImage);
    /** @type {Buffer | null} */
    let cropDebugBuffer = null;
    if (showCrops) {
      cropDebugBuffer = await buildGovGearCropDebugSheet(gearBuffer);
    }
    const parsed = {
      resources: {
        satin: satin === null ? null : Math.max(0, Number(satin)),
        gildedThreads: gildedThreads === null ? null : Math.max(0, Number(gildedThreads)),
        artisansVision: artisansVision === null ? null : Math.max(0, Number(artisansVision)),
      },
      pieceLevels: {
        infantry1: null,
        infantry2: null,
        cavalry1: null,
        cavalry2: null,
        archery1: null,
        archery2: null,
      },
    };
    const overrides = {
      pieceLevels: {
        infantry1:
          parseGovGearLabelOverride(interaction, "infantry1_label") ??
          parseGovGearOverride(interaction, "infantry1"),
        infantry2:
          parseGovGearLabelOverride(interaction, "infantry2_label") ??
          parseGovGearOverride(interaction, "infantry2"),
        cavalry1:
          parseGovGearLabelOverride(interaction, "cavalry1_label") ??
          parseGovGearOverride(interaction, "cavalry1"),
        cavalry2:
          parseGovGearLabelOverride(interaction, "cavalry2_label") ??
          parseGovGearOverride(interaction, "cavalry2"),
        archery1:
          parseGovGearLabelOverride(interaction, "archery1_label") ??
          parseGovGearOverride(interaction, "archery1"),
        archery2:
          parseGovGearLabelOverride(interaction, "archery2_label") ??
          parseGovGearOverride(interaction, "archery2"),
      },
    };

    for (const k of Object.keys(overrides.pieceLevels)) {
      if (overrides.pieceLevels[k] !== null) parsed.pieceLevels[k] = overrides.pieceLevels[k];
    }

    const gearSlotKeys = [
      "infantry1",
      "infantry2",
      "cavalry1",
      "cavalry2",
      "archery1",
      "archery2",
    ];
    const hadOverride = Object.fromEntries(
      gearSlotKeys.map((k) => [k, overrides.pieceLevels[k] != null])
    );

    const minTemplateScore =
      Number.parseFloat(String(process.env.GOV_GEAR_TEMPLATE_MIN_SCORE || "0.24"), 10) || 0.24;
    const bank = await getGovGearTemplateBank();
    if (!bank || !bank.imageCount) {
      const errEmbed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle("Template library missing")
        .setDescription(
          "Add labeled pairs under the `Kingshot-image/` folder (screenshot + matching `.txt` lines) on the server, or set `GOV_GEAR_TEMPLATE_DIR` in `.env`.\n" +
            "You can still pass all six gear levels using the optional `*_label` / integer override fields."
        );
      if (cropDebugBuffer) {
        errEmbed.setImage(`attachment://${GOV_GEAR_DEBUG_FILENAME}`);
      }
      await interaction.editReply({
        embeds: [errEmbed],
        files: cropDebugBuffer
          ? [new AttachmentBuilder(cropDebugBuffer, { name: GOV_GEAR_DEBUG_FILENAME })]
          : [],
      });
      return;
    }

    /** @type {Record<string, number> | null} */
    let templateScores = null;
    let slotsFilledByTemplate = 0;
    const matchExtractors = [];
    for (const mode of ["detected", "full"]) {
      for (const sh of GOV_GEAR_TEMPLATE_MICRO_SHIFTS) {
        matchExtractors.push((buf) => extractGovGearSlotCrops(buf, mode, sh));
      }
    }
    const match = await matchGovGearSlotsFromTemplateBank(
      gearBuffer,
      bank,
      matchExtractors,
      minTemplateScore
    );
    if (match) {
      templateScores = match.scores;
      for (const k of gearSlotKeys) {
        if (hadOverride[k]) continue;
        const v = match.pieceLevels[k];
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          parsed.pieceLevels[k] = v;
          slotsFilledByTemplate += 1;
        }
      }
    }

    const slotsWithoutOverride = gearSlotKeys.filter((k) => !hadOverride[k]).length;
    /** @type {{ gearSource?: string; templateScores?: Record<string, number> | null }} */
    const previewMeta = {};
    if (templateScores) previewMeta.templateScores = templateScores;
    if (bank && templateScores && slotsWithoutOverride > 0) {
      if (slotsFilledByTemplate >= slotsWithoutOverride) previewMeta.gearSource = "template";
      else if (slotsFilledByTemplate > 0) previewMeta.gearSource = "partial";
    }

    const missing = [];
    if (parsed.resources.satin === null || !Number.isFinite(parsed.resources.satin)) {
      missing.push("satin");
    }
    if (
      parsed.resources.gildedThreads === null ||
      !Number.isFinite(parsed.resources.gildedThreads)
    ) {
      missing.push("gilded_threads");
    }
    if (
      parsed.resources.artisansVision === null ||
      !Number.isFinite(parsed.resources.artisansVision)
    ) {
      missing.push("artisans_vision");
    }
    for (const [k, v] of Object.entries(parsed.pieceLevels)) {
      if (v === null || v === undefined || !Number.isFinite(v)) missing.push(k);
    }

    if (missing.length) {
      const errEmbed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle("Missing required values")
        .setDescription(
          `**Missing:** ${missing.join(", ")}\n\n` +
            "For resources, enter manual values (`satin`, `gilded_threads`, `artisans_vision`).\n" +
            "For gear slots, add similar labeled screenshots to `Kingshot-image/`, lower `GOV_GEAR_TEMPLATE_MIN_SCORE` in `.env`, or set overrides (`infantry1_label`, …)."
        );
      if (cropDebugBuffer) {
        errEmbed.setImage(`attachment://${GOV_GEAR_DEBUG_FILENAME}`);
      }
      await interaction.editReply({
        embeds: [errEmbed],
        files: cropDebugBuffer
          ? [new AttachmentBuilder(cropDebugBuffer, { name: GOV_GEAR_DEBUG_FILENAME })]
          : [],
      });
      return;
    }

    if (cropDebugBuffer) previewMeta.showCropsAttachment = true;
    const previewEmbed = buildGovGearPreviewEmbed(parsed, previewMeta);
    if (cropDebugBuffer) {
      previewEmbed.setImage(`attachment://${GOV_GEAR_DEBUG_FILENAME}`);
    }
    const confirmId = `govgear_confirm_${interaction.id}`;
    const cancelId = `govgear_cancel_${interaction.id}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );

    const previewMessage = await interaction.editReply({
      embeds: [previewEmbed],
      components: [row],
      files: cropDebugBuffer
        ? [new AttachmentBuilder(cropDebugBuffer, { name: GOV_GEAR_DEBUG_FILENAME })]
        : [],
    });

    let confirmed = false;
    try {
      const btn = await previewMessage.awaitMessageComponent({
        filter: (i) =>
          i.user.id === interaction.user.id &&
          (i.customId === confirmId || i.customId === cancelId),
        time: 120000,
      });
      if (btn.customId === cancelId) {
        await btn.update({
          content: "Optimization canceled. Re-run `/govgearopt` with corrected screenshots/overrides.",
          embeds: [],
          components: [],
        });
        return;
      }
      confirmed = true;
      await btn.deferUpdate();
    } catch {
      await interaction.editReply({
        content: "Confirmation timed out. Re-run `/govgearopt` when ready.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (!confirmed) return;

    const payload = buildGovGearPayload(parsed);
    const res = await fetch(`${governorGearOptimizerApiBase}/governor-gear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const rawText = await res.text();
    let json;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }

    if (!res.ok || !json?.success || !json?.result) {
      const msg = json?.error || `Optimizer API failed (${res.status}).`;
      await interaction.editReply({ content: msg, embeds: [], components: [] });
      return;
    }

    const result = json.result;
    const recSummary = summarizeGovGearRecommendations(result.recommendations, 8);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("Governor Gear Optimization Result")
      .setDescription(recSummary)
      .addFields(
        {
          name: "Parsed Resources",
          value: `Satin: ${parsed.resources.satin}\nGilded Threads: ${parsed.resources.gildedThreads}\nArtisan's Vision: ${parsed.resources.artisansVision}`,
          inline: true,
        },
        {
          name: "Parsed Gear Levels",
          value:
          `Inf1: ${formatGovGearStep(parsed.pieceLevels.infantry1)} (${parsed.pieceLevels.infantry1})\n` +
          `Inf2: ${formatGovGearStep(parsed.pieceLevels.infantry2)} (${parsed.pieceLevels.infantry2})\n` +
          `Cav1: ${formatGovGearStep(parsed.pieceLevels.cavalry1)} (${parsed.pieceLevels.cavalry1})\n` +
          `Cav2: ${formatGovGearStep(parsed.pieceLevels.cavalry2)} (${parsed.pieceLevels.cavalry2})\n` +
          `Arc1: ${formatGovGearStep(parsed.pieceLevels.archery1)} (${parsed.pieceLevels.archery1})\n` +
          `Arc2: ${formatGovGearStep(parsed.pieceLevels.archery2)} (${parsed.pieceLevels.archery2})`,
          inline: true,
        },
        {
          name: "Totals",
          value:
            `Stat Gain: ${Number(result.totalStatGain || 0).toFixed(2)}\n` +
            `Power Gain: ${Number(result.totalPowerGain || 0).toLocaleString()}\n` +
            `Event Points: ${Number(result.totalEventPoints || 0).toLocaleString()}`,
          inline: false,
        },
        {
          name: "Resource Usage",
          value:
            `Used - S:${result.resourcesUsed?.satin ?? 0} GT:${result.resourcesUsed?.gildedThreads ?? 0} AV:${result.resourcesUsed?.artisansVision ?? 0}\n` +
            `Left - S:${result.resourcesRemaining?.satin ?? 0} GT:${result.resourcesRemaining?.gildedThreads ?? 0} AV:${result.resourcesRemaining?.artisansVision ?? 0}`,
          inline: false,
        }
      )
      .setFooter({ text: "Source: api.kingshotoptimizer.com/governor-gear" });

    const detailsFile = new AttachmentBuilder(
      Buffer.from(JSON.stringify({ payload, result }, null, 2), "utf8"),
      { name: "govgear-optimization.json" }
    );

    await interaction.editReply({ embeds: [embed], files: [detailsFile], components: [] });
  } catch (err) {
    console.error("govgear optimization failed:", err);
    await interaction.editReply({
      content: "Failed to process images or run optimization. Try clearer screenshots and retry.",
    });
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    ...(needsMessageIntents
      ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
      : []),
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  c.user.setActivity("Kingshot lookups", { type: ActivityType.Watching });

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    if (guildId) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body: commands,
        });
        console.log(`Slash commands registered for guild ${guildId}.`);
      } catch (guildErr) {
        const code = guildErr.code ?? guildErr?.rawError?.code;
        if (code === 50001) {
          console.warn(
            "Guild command registration failed (Missing Access). Usually: wrong GUILD_ID, or the bot is not in that server. " +
              "Check .env and re-invite the bot. Falling back to global registration..."
          );
          await rest.put(Routes.applicationCommands(clientId), { body: commands });
          console.log("Slash commands registered globally (may take up to ~1 hour to appear).");
        } else {
          throw guildErr;
        }
      }
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log("Slash commands registered globally (may take ~1 hour to appear).");
    }
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }

  // OCR features removed.
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!["kingshot", "kvkmatches", "kingdomage", "govgearopt"].includes(interaction.commandName))
    return;

  if (!channelAllowed(interaction.channelId)) {
    await interaction.reply({
      content: "Player lookup is only allowed in the designated channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    if (interaction.commandName === "kingshot") {
      const playerId = interaction.options.getString("player_id", true);
      await replyWithPlayerLookup(interaction, playerId);
      return;
    }

    if (interaction.commandName === "kvkmatches") {
      await replyWithKvkMatches(interaction);
      return;
    }

    if (interaction.commandName === "kingdomage") {
      await replyWithKingdomAge(interaction);
      return;
    }

    if (interaction.commandName === "govgearopt") {
      await replyWithGovGearOptimization(interaction);
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: "Something went wrong while fetching player data.",
        });
      } else {
        await interaction.reply({
          content: "Something went wrong while fetching player data.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* ignore */
    }
  }
});

if (needsMessageIntents) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    if (enableNicknameChannel && message.channelId === nicknameChannelId) {
      await handleNicknameChannelMessage(message);
      return;
    }

    if (!enableSimpleMessages) return;
    if (!channelAllowed(message.channelId)) return;

    const content = message.content.trim();

    const pazamMatch = content.match(/^פז["״']?[מם]\s*#?(\d{1,4})$/);
    if (pazamMatch) {
      const kingdomId = Number(pazamMatch[1]);
      const ageRes = await buildKingdomAgeEmbed(kingdomId);
      if (!ageRes.ok) {
        await message.reply({ content: ageRes.message });
        return;
      }
      await message.reply(buildEmbedReplyPayload([ageRes.embed]));
      return;
    }

    if (!/^\d{1,20}$/.test(content)) return;

    // Kingdom IDs are short numbers in this flow (1-4 digits).
    if (content.length <= 4) {
      const kingdomId = Number(content);
      const kvkResult = await fetchKvkMatchesForKingdom({ kingdomId });
      if (!kvkResult.ok) {
        await message.reply({ content: kvkResult.message });
        return;
      }
      if (!kvkResult.data.length) {
        await message.reply({ content: `No KvK matches found for kingdom #${kingdomId}.` });
        return;
      }

      await message.reply({
        embeds: buildKvkMatchesEmbeds(kvkResult.data, { kingdomId }, null),
      });
      return;
    }

    const playerResult = await fetchPlayerInfo(content);
    if (!playerResult.ok) {
      await message.reply({ content: playerResult.message });
      return;
    }

    await message.reply({ embeds: [buildPlayerEmbed(playerResult.data, content)] });
  });
}

client.login(token).catch((e) => {
  console.error("Login failed:", e);
  process.exit(1);
});
