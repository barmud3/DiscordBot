require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  fetchPlayerInfo,
  fetchKvkMatchesForKingdom,
  fetchKingdomTrackerById,
  fetchGovernorGearOptimization,
} = require("./kingshot-api");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID || "";
const brandImageUrl = process.env.BRAND_IMAGE_URL || "";

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
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
    ),
  new SlashCommandBuilder()
    .setName("kvkmatches")
    .setDescription("Get all available KvK records for a kingdom")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Kingdom ID (example: 220)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("kingdomage")
    .setDescription("Show kingdom age and open time")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Kingdom ID (example: 220)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("optimizegovgear")
    .setDescription("Prepare governor gear optimization request")
    .addIntegerOption((o) =>
      o.setName("satin").setDescription("Available Satin").setRequired(true).setMinValue(0)
    )
    .addIntegerOption((o) =>
      o.setName("gilded_threads").setDescription("Available Gilded Threads").setRequired(true).setMinValue(0)
    )
    .addIntegerOption((o) =>
      o
        .setName("artisans_vision")
        .setDescription("Available Artisan's Vision")
        .setRequired(true)
        .setMinValue(0)
    )
    .addStringOption((o) =>
      o
        .setName("hat")
        .setDescription("Hat (cav1) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("chain")
        .setDescription("Chain (cav2) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("shirt")
        .setDescription("Shirt (inf1) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("pants")
        .setDescription("Pants (inf2) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("ring")
        .setDescription("Ring (arch1) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((o) =>
      o
        .setName("baton")
        .setDescription("Baton (arch2) - type level text")
        .setRequired(true)
        .setAutocomplete(true)
    ),
];

const GOV_GEAR_LEVELS = [
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
const pendingGovGearSubmissions = new Map();
const govGearChatSessions = new Map();
const govGearModalSessions = new Map();
const GOV_GEAR_MEMORY_FILE = path.resolve(__dirname, "..", "data", "govgear-user-memory.json");
const GOV_GEAR_CHAT_TRIGGER_PHRASES = new Set(["hero gear", "הירו גיר"]);
const GOV_GEAR_CHAT_CANCEL_PHRASES = new Set(["cancel", "exit", "stop", "quit"]);

const GOV_GEAR_CHAT_STEPS = [
  { key: "satin", prompt: "Enter **Satin** amount (number):", type: "number" },
  { key: "gildedThreads", prompt: "Enter **Gilded Threads** amount (number):", type: "number" },
  { key: "artisansVision", prompt: "Enter **Artisan's Vision** amount (number):", type: "number" },
  { key: "hat", prompt: "Enter **Hat (cav1)** level:", type: "gear" },
  { key: "chain", prompt: "Enter **Chain (cav2)** level:", type: "gear" },
  { key: "shirt", prompt: "Enter **Shirt (inf1)** level:", type: "gear" },
  { key: "pants", prompt: "Enter **Pants (inf2)** level:", type: "gear" },
  { key: "ring", prompt: "Enter **Ring (arch1)** level:", type: "gear" },
  { key: "baton", prompt: "Enter **Baton (arch2)** level:", type: "gear" },
];
const GOV_GEAR_SLOT_STEPS = [
  { key: "hat", label: "Hat (cav1)" },
  { key: "chain", label: "Chain (cav2)" },
  { key: "shirt", label: "Shirt (inf1)" },
  { key: "pants", label: "Pants (inf2)" },
  { key: "ring", label: "Ring (arch1)" },
  { key: "baton", label: "Baton (arch2)" },
];

function formatDiscordTimestampFromUnix(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `<t:${Math.floor(n)}:F>`;
}

function pickPlayerIdValue(data) {
  return (
    data.id ??
    data.playerId ??
    data.player_id ??
    data.role_id ??
    data.uid ??
    data.user_id ??
    null
  );
}

function normalizeGovGearLevel(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const compact = raw
    .toLowerCase()
    .replace(/[🌟⭐]/g, "*")
    .replace(/\s+/g, "");
  return (
    GOV_GEAR_LEVELS.find(
      (v) =>
        v
          .toLowerCase()
          .replace(/[🌟⭐]/g, "*")
          .replace(/\s+/g, "") === compact
    ) || null
  );
}

function normalizeTriggerText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[!?.,:;'"`~@#$%^&*()_+\-[\]{}\\/|<>]/g, "")
    .replace(/\s+/g, " ");
}

function getGovGearChatSessionKey(message) {
  return `${message.guildId || "dm"}:${message.channelId}:${message.author.id}`;
}

function loadGovGearMemoryStore() {
  try {
    if (!fs.existsSync(GOV_GEAR_MEMORY_FILE)) return {};
    const raw = fs.readFileSync(GOV_GEAR_MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveGovGearMemoryStore(store) {
  try {
    const dir = path.dirname(GOV_GEAR_MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GOV_GEAR_MEMORY_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (_) {
    // ignore persistence failures, bot should still work
  }
}

function getUserGovGearMemory(userId) {
  const store = loadGovGearMemoryStore();
  const value = store[String(userId)];
  if (!value || typeof value !== "object") return null;
  return value.data && typeof value.data === "object" ? value.data : null;
}

function rememberUserGovGearMemory(userId, data) {
  const store = loadGovGearMemoryStore();
  store[String(userId)] = {
    updatedAt: new Date().toISOString(),
    data,
  };
  saveGovGearMemoryStore(store);
}

function parseRequestIdFromCustomId(customId, expectedPrefix) {
  if (!customId.startsWith(expectedPrefix)) return null;
  return customId.slice(expectedPrefix.length);
}

function parseGovernorAdvancedSettingsFromFields(fields) {
  const profileRaw = String(fields.getTextInputValue("weightProfile") || "").trim().toLowerCase();
  const profileMap = {
    growth: "earlyGameGrowth",
    earlygamegrowth: "earlyGameGrowth",
    combat: "earlyGameCombat",
    earlygamecombat: "earlyGameCombat",
    future: "futureProofed",
    futureproofed: "futureProofed",
    unweighted: "unweighted",
  };
  const troopRaw = String(fields.getTextInputValue("troopTypeFilter") || "").trim().toLowerCase();
  const troopMap = { all: "all", infantry: "infantry", cavalry: "cavalry", archery: "archery", archer: "archery" };
  const modeRaw = String(fields.getTextInputValue("optimizationMode") || "").trim().toLowerCase();
  const modeMap = { stats: "optimize-stats", events: "optimize-events", "optimize-stats": "optimize-stats", "optimize-events": "optimize-events" };
  const ampRaw = String(fields.getTextInputValue("amplification") || "").trim();
  const maxUpgradesRaw = String(fields.getTextInputValue("maxUpgrades") || "").trim();

  const out = {};
  if (profileRaw) {
    const mapped = profileMap[profileRaw.replace(/\s+/g, "")];
    if (!mapped) return { ok: false, message: "Invalid Weight profile. Use: growth, combat, future, or unweighted." };
    out.weightSettings = { enabled: true, profile: mapped };
  }
  if (ampRaw) {
    const amp = Number(ampRaw);
    if (!Number.isFinite(amp) || amp < 1 || amp > 2) {
      return { ok: false, message: "Amplification factor must be a number between 1.0 and 2.0." };
    }
    out.weightSettings = out.weightSettings || { enabled: true, profile: "earlyGameGrowth" };
    out.weightSettings.scalingAmplifier = amp;
  }
  if (troopRaw) {
    const mapped = troopMap[troopRaw.replace(/\s+/g, "")];
    if (!mapped) return { ok: false, message: "Troop filter must be one of: all, infantry, cavalry, archery." };
    out.troopTypeFilter = mapped;
  }
  if (modeRaw) {
    const mapped = modeMap[modeRaw.replace(/\s+/g, "")];
    if (!mapped) return { ok: false, message: "Optimization mode must be: stats or events." };
    out.optimizationMode = mapped;
  }
  if (maxUpgradesRaw) {
    const maxUpgrades = Number(maxUpgradesRaw);
    if (!Number.isFinite(maxUpgrades) || maxUpgrades <= 0) {
      return { ok: false, message: "Max upgrades must be a positive number." };
    }
    out.maxUpgrades = Math.floor(maxUpgrades);
  }
  return { ok: true, settings: out };
}

function hasCompleteGearData(data) {
  if (!data) return false;
  return GOV_GEAR_SLOT_STEPS.every((s) => data[s.key] && String(data[s.key]).trim());
}

function formatSavedGearSummaryLines(data) {
  return GOV_GEAR_SLOT_STEPS.map((s) => `• **${s.label}**: ${data[s.key] || "—"}`).join("\n");
}

function buildSavedGearReviewView(requestId, data) {
  const satin = data.satin != null && data.satin !== "" ? data.satin : "—";
  const threads = data.gildedThreads != null && data.gildedThreads !== "" ? data.gildedThreads : "—";
  const vision = data.artisansVision != null && data.artisansVision !== "" ? data.artisansVision : "—";
  const content =
    "**Saved governor gear** (tap a slot to change, or go to resources)\n" +
    `${formatSavedGearSummaryLines(data)}\n\n` +
    `**Resources (next step):** Satin \`${satin}\` · Gilded Threads \`${threads}\` · Artisan's Vision \`${vision}\``;

  const shortLabel = (full) => full.replace(/\s*\([^)]+\)\s*$/, "");
  const row1 = new ActionRowBuilder().addComponents(
    ...GOV_GEAR_SLOT_STEPS.slice(0, 5).map((s, i) =>
      new ButtonBuilder()
        .setCustomId(`optimizegovgear:editslot:${requestId}:${i}`)
        .setLabel(shortLabel(s.label).slice(0, 80))
        .setStyle(ButtonStyle.Secondary)
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:editslot:${requestId}:5`)
      .setLabel(shortLabel(GOV_GEAR_SLOT_STEPS[5].label).slice(0, 80))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:openmodal2:${requestId}`)
      .setLabel("Continue to resources")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:restartwizard:${requestId}`)
      .setLabel("Clear gear & start over")
      .setStyle(ButtonStyle.Danger)
  );
  return { content, components: [row1, row2] };
}

function buildGovGearSelectView(requestId, slotIndex, page) {
  const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
  const pageSize = 25;
  const totalPages = Math.ceil(GOV_GEAR_LEVELS.length / pageSize);
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const options = GOV_GEAR_LEVELS.slice(safePage * pageSize, (safePage + 1) * pageSize).map((level) => ({
    label: level,
    value: level,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`optimizegovgear:pick:${requestId}:${slotIndex}:${safePage}`)
    .setPlaceholder(`Choose ${slot.label}`)
    .addOptions(options);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:nav:${requestId}:${slotIndex}:${Math.max(0, safePage - 1)}`)
    .setLabel("Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:nav:${requestId}:${slotIndex}:${Math.min(totalPages - 1, safePage + 1)}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages - 1);
  const cancelBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:cancel:${requestId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);

  return {
    content:
      `Select **${slot.label}**\n` +
      `Page ${safePage + 1}/${totalPages} (use **Next** for higher tiers like Gold T3 / Red)`,
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(prevBtn, nextBtn, cancelBtn)],
  };
}

const GOV_GEAR_EDIT_PAGE_SIZE = 25;

/** Start index for the edit window: center the saved tier when possible so the same dropdown shows lower and higher tiers (not only above). */
function defaultGovGearEditWindowStart(currentRaw) {
  const trimmed = String(currentRaw || "").trim();
  const canonical = trimmed ? normalizeGovGearLevel(trimmed) || trimmed : null;
  if (!canonical) return 0;
  const idx = GOV_GEAR_LEVELS.indexOf(canonical);
  if (idx < 0) return 0;
  const len = GOV_GEAR_LEVELS.length;
  const ps = GOV_GEAR_EDIT_PAGE_SIZE;
  const maxStart = Math.max(0, len - ps);
  const half = Math.floor(ps / 2);
  const idealStart = idx - half;
  return Math.max(0, Math.min(idealStart, maxStart));
}

function clampGovGearEditWindowStart(rawStart) {
  const maxStart = Math.max(0, GOV_GEAR_LEVELS.length - GOV_GEAR_EDIT_PAGE_SIZE);
  const n = Math.floor(Number(rawStart));
  const start = Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(start, maxStart));
}

/** Same as wizard select, but updates one slot from saved-gear review (customIds differ). `windowStart` = index into GOV_GEAR_LEVELS for the first row. */
function buildGovGearEditSelectView(requestId, slotIndex, windowStart, savedRaw) {
  const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
  const start = clampGovGearEditWindowStart(windowStart);
  const len = GOV_GEAR_LEVELS.length;
  const maxStart = Math.max(0, len - GOV_GEAR_EDIT_PAGE_SIZE);
  const end = Math.min(start + GOV_GEAR_EDIT_PAGE_SIZE, len);
  const slice = GOV_GEAR_LEVELS.slice(start, end);
  const trimmedSave = String(savedRaw ?? "").trim();
  const savedCanon = trimmedSave ? normalizeGovGearLevel(trimmedSave) || trimmedSave : "";
  const savedLine = savedCanon ? `Saved: **${savedCanon}**\n` : "";
  const options = slice.map((level) => {
    const label = level.length > 100 ? `${level.slice(0, 99)}…` : level;
    const opt = new StringSelectMenuOptionBuilder().setLabel(label).setValue(level);
    if (savedCanon && level === savedCanon) {
      opt.setDefault(true);
    }
    return opt;
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`optimizegovgear:pickedit:${requestId}:${slotIndex}:${start}`)
    .setPlaceholder(savedCanon ? savedCanon : `Change ${slot.label}`)
    .addOptions(options);

  const prevBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:navedit:${requestId}:${slotIndex}:${Math.max(0, start - GOV_GEAR_EDIT_PAGE_SIZE)}`)
    .setLabel("Prev")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(start <= 0);
  const nextBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:navedit:${requestId}:${slotIndex}:${Math.min(maxStart, start + GOV_GEAR_EDIT_PAGE_SIZE)}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(start >= maxStart);
  const backBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:backreview:${requestId}`)
    .setLabel("Back to summary")
    .setStyle(ButtonStyle.Primary);

  return {
    content:
      `Edit **${slot.label}**\n` +
      (savedLine || "") +
      `Tiers **${start + 1}–${end}** of **${len}** (saved tier **centered** in this window when possible, so lower and higher tiers both appear). **Prev** / **Next** for more.`,
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(prevBtn, nextBtn, backBtn)],
  };
}

function buildOptimizerResultText(data) {
  if (!data || typeof data !== "object") return "No optimization details were returned.";

  const topArray =
    (Array.isArray(data.recommendations) && data.recommendations) ||
    (Array.isArray(data.upgrades) && data.upgrades) ||
    (Array.isArray(data.plan) && data.plan) ||
    [];

  if (topArray.length) {
    const pieceNameById = {
      cavalry_gear_1: "Hat (cav1)",
      cavalry_gear_2: "Chain (cav2)",
      infantry_gear_1: "Shirt (inf1)",
      infantry_gear_2: "Pants (inf2)",
      archery_gear_1: "Ring (arch1)",
      archery_gear_2: "Baton (arch2)",
    };
    const fallbackNameMap = {
      "Cavalry Gear Piece 1": "Hat (cav1)",
      "Cavalry Gear Piece 2": "Chain (cav2)",
      "Infantry Gear Piece 1": "Shirt (inf1)",
      "Infantry Gear Piece 2": "Pants (inf2)",
      "Archery Gear Piece 1": "Ring (arch1)",
      "Archery Gear Piece 2": "Baton (arch2)",
    };
    const stepToLabel = (step) => {
      if (!Number.isFinite(step)) return "?";
      if (step < 0) return "No Gear";
      return GOV_GEAR_LEVELS[step] || `Step ${step}`;
    };

    const grouped = new Map();
    for (const item of topArray.slice(0, 20)) {
      if (typeof item === "string") continue;
      const pieceId = item.piece?.id || item.slot || item.item || item.name || "unknown_piece";
      const displayName =
        pieceNameById[item.piece?.id] ||
        fallbackNameMap[item.piece?.name] ||
        fallbackNameMap[item.slot] ||
        item.piece?.name ||
        item.slot ||
        item.item ||
        item.name ||
        "Gear";
      const fromStep = Number(item.fromStep);
      const toStep = Number(item.toStep);
      const from = item.from || item.current || item.currentLevel || null;
      const to = item.to || item.target || item.next || item.nextLevel || null;

      const existing = grouped.get(pieceId);
      if (!existing) {
        grouped.set(pieceId, {
          piece: displayName,
          fromStep,
          toStep,
          from,
          to,
          count: 1,
        });
      } else {
        existing.count += 1;
        if (Number.isFinite(toStep)) existing.toStep = toStep;
        if (to) existing.to = to;
      }
    }

    const lines = Array.from(grouped.values())
      .slice(0, 8)
      .map((entry, index) => {
        if (Number.isFinite(entry.fromStep) && Number.isFinite(entry.toStep)) {
          const extra = entry.count > 1 ? ` (${entry.count} upgrades)` : "";
          return `${index + 1}. ${entry.piece}: ${stepToLabel(entry.fromStep)} -> ${stepToLabel(entry.toStep)}${extra}`;
        }
        const fromText = entry.from || "?";
        const toText = entry.to || "?";
        return `${index + 1}. ${entry.piece}: ${fromText} -> ${toText}`;
      });
    return lines.join("\n");
  }

  if (typeof data.summary === "string" && data.summary.trim()) return data.summary.trim();
  if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
  return "Optimization completed, but no readable recommendation list was returned.";
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = commands.map((c) => c.toJSON());
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log(`Registered guild commands for guild ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("Registered global commands (may take up to ~1 hour to show).");
  }
}

async function handleKingshot(interaction) {
  const playerId = interaction.options.getString("player_id", true).trim();
  if (!/^\d{5,20}$/.test(playerId)) {
    await interaction.editReply({
      content: "Please provide a valid numeric player ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const res = await fetchPlayerInfo(playerId);
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch player info right now.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const data = res.data || {};
  const idValue = pickPlayerIdValue(data);
  const name = data.name || data.nickname || data.nickName || "Unknown";
  const kingdom = data.kingdomId ?? data.kingdom_id ?? data.serverId ?? data.server_id ?? "Unknown";
  const level = data.level ?? data.castleLevel ?? data.castle_level ?? "Unknown";
  const profileImage = data.avatar || data.avatarUrl || data.profileImage || data.image || null;

  const embed = new EmbedBuilder()
    .setTitle("Kingshot Player Lookup")
    .setColor(0x00a6ff)
    .addFields(
      { name: "Player Name", value: String(name), inline: true },
      { name: "Player ID", value: String(idValue ?? playerId), inline: true },
      { name: "Kingdom", value: `#${String(kingdom)}`, inline: true },
      { name: "Level", value: String(level), inline: true }
    )
    .setTimestamp(new Date());

  if (brandImageUrl) embed.setThumbnail(brandImageUrl);
  if (profileImage) embed.setImage(profileImage);

  await interaction.editReply({ embeds: [embed] });
}

async function handleKvkMatches(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    await interaction.editReply({
      content: "Please provide a valid kingdom ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const res = await fetchKvkMatchesForKingdom({ kingdomId });
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch KvK matches right now.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const rows = (res.data || []).slice(0, 20);
  if (!rows.length) {
    await interaction.editReply({ content: `No KvK matches found for kingdom #${kingdomId}.` });
    return;
  }

  const lines = rows.map((m) => {
    const kvkId = m.kvk_id ?? "N/A";
    const season = m.season_id ?? "N/A";
    const a = m.kingdom_a ?? "?";
    const b = m.kingdom_b ?? "?";
    const status = m.status ?? "unknown";
    return `• KvK ${kvkId} (S${season}): #${a} vs #${b} [${status}]`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`KvK Matches for #${kingdomId}`)
    .setColor(0xff8f00)
    .setDescription(lines.join("\n"))
    .setFooter({ text: "Source: kingshot.net/api/kvk/matches" })
    .setTimestamp(new Date());

  if (brandImageUrl) embed.setThumbnail(brandImageUrl);
  await interaction.editReply({ embeds: [embed] });
}

async function handleKingdomAge(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    await interaction.editReply({
      content: "Please provide a valid kingdom ID.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const res = await fetchKingdomTrackerById(kingdomId);
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch kingdom tracker data right now.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const data = res.data || {};
  const openUnix =
    data.open_time ?? data.openTime ?? data.open_at ?? data.openAt ?? data.create_time ?? data.createTime;
  const ageDays = data.age_days ?? data.ageDays ?? data.days ?? data.open_days ?? "Unknown";
  const openTs = formatDiscordTimestampFromUnix(openUnix);

  const embed = new EmbedBuilder()
    .setTitle(`Kingdom #${kingdomId} Age`)
    .setColor(0x7b1fa2)
    .addFields(
      { name: "Kingdom", value: `#${kingdomId}`, inline: true },
      { name: "Age (days)", value: String(ageDays), inline: true },
      { name: "Open Time", value: openTs || "Unknown", inline: false }
    )
    .setFooter({ text: "Source: kingshot.net/api/kingdom-tracker" })
    .setTimestamp(new Date());

  if (brandImageUrl) embed.setThumbnail(brandImageUrl);
  await interaction.editReply({ embeds: [embed] });
}

async function handleOptimizeGovGear(interaction) {
  const satin = interaction.options.getInteger("satin", true);
  const gildedThreads = interaction.options.getInteger("gilded_threads", true);
  const artisansVision = interaction.options.getInteger("artisans_vision", true);

  const levels = {
    hat: normalizeGovGearLevel(interaction.options.getString("hat", true)),
    chain: normalizeGovGearLevel(interaction.options.getString("chain", true)),
    shirt: normalizeGovGearLevel(interaction.options.getString("shirt", true)),
    pants: normalizeGovGearLevel(interaction.options.getString("pants", true)),
    ring: normalizeGovGearLevel(interaction.options.getString("ring", true)),
    baton: normalizeGovGearLevel(interaction.options.getString("baton", true)),
  };

  const badInput = Object.entries(levels).find(([, value]) => !value);
  if (badInput) {
    await interaction.editReply({
      content: `Invalid ${badInput[0]} value. Pick from autocomplete or use exact text (example: \`Gold T2⭐⭐\`).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requestId = `${interaction.user.id}-${Date.now()}`;
  const lastMemory = getUserGovGearMemory(interaction.user.id) || {};
  pendingGovGearSubmissions.set(requestId, {
    userId: interaction.user.id,
    data: { ...lastMemory, satin, gildedThreads, artisansVision, ...levels },
    createdAt: Date.now(),
  });

  const submitButton = new ButtonBuilder()
    .setCustomId(`optimizegovgear:submit:${requestId}`)
    .setLabel("Submit")
    .setStyle(ButtonStyle.Primary);
  const advancedButton = new ButtonBuilder()
    .setCustomId(`optimizegovgear:openadvanced:${requestId}`)
    .setLabel("Advanced (Optional)")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(submitButton, advancedButton);
  await interaction.editReply({
    content:
      `Review inputs, then press **Submit**.\n\n` +
      `Resources:\n- Satin: ${satin}\n- Gilded Threads: ${gildedThreads}\n- Artisan's Vision: ${artisansVision}\n\n` +
      `Gear:\n- Hat (cav1): ${levels.hat}\n- Chain (cav2): ${levels.chain}\n- Shirt (inf1): ${levels.shirt}\n- Pants (inf2): ${levels.pants}\n- Ring (arch1): ${levels.ring}\n- Baton (arch2): ${levels.baton}`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleGovGearSubmitButton(interaction) {
  const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:submit:");
  if (!requestId) {
    await interaction.reply({
      content: "This submit request is invalid. Please run /optimizegovgear again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const pending = pendingGovGearSubmissions.get(requestId);
  if (!pending) {
    await interaction.reply({
      content: "This submit request expired. Please run /optimizegovgear again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (pending.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the command owner can submit this request.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  rememberUserGovGearMemory(interaction.user.id, pending.data);
  const result = await fetchGovernorGearOptimization(pending.data);
  pendingGovGearSubmissions.delete(requestId);

  if (!result.ok) {
    await interaction.editReply(
      `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/governor-gear/optimize>`
    );
    return;
  }

  const recommendationText = buildOptimizerResultText(result.data);
  await interaction.editReply(
    `Optimizer recommendation:\n${recommendationText}\n\nSource: <https://kingshotoptimizer.com/governor-gear/optimize>`
  );
}

function buildGovGearModalOne(requestId, defaults = {}) {
  const modal = new ModalBuilder().setCustomId(`optimizegovgear:modal1:${requestId}`).setTitle("Governor Gear Panel 1/2");
  const fields = [
    { key: "hat", label: "Hat (cav1)" },
    { key: "chain", label: "Chain (cav2)" },
    { key: "shirt", label: "Shirt (inf1)" },
    { key: "pants", label: "Pants (inf2)" },
    { key: "ring", label: "Ring (arch1)" },
  ];
  for (const field of fields) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(field.key)
          .setLabel(field.label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("Example: Gold T3⭐⭐")
          .setValue(defaults[field.key] || "")
      )
    );
  }
  return modal;
}

function buildGovGearModalTwo(requestId, defaults = {}) {
  const modal = new ModalBuilder().setCustomId(`optimizegovgear:modal2:${requestId}`).setTitle("Governor Gear Panel 2/2");
  const satin = new TextInputBuilder()
    .setCustomId("satin")
    .setLabel("Satin (number)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("0")
    .setValue(String(defaults.satin ?? ""));
  const gildedThreads = new TextInputBuilder()
    .setCustomId("gildedThreads")
    .setLabel("Gilded Threads (number)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("0")
    .setValue(String(defaults.gildedThreads ?? ""));
  const artisansVision = new TextInputBuilder()
    .setCustomId("artisansVision")
    .setLabel("Artisan's Vision (number)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("0")
    .setValue(String(defaults.artisansVision ?? ""));
  modal.addComponents(
    new ActionRowBuilder().addComponents(satin),
    new ActionRowBuilder().addComponents(gildedThreads),
    new ActionRowBuilder().addComponents(artisansVision)
  );
  return modal;
}

function buildGovGearAdvancedModal(requestId, defaults = {}) {
  const modal = new ModalBuilder().setCustomId(`optimizegovgear:modaladvanced:${requestId}`).setTitle("Governor Gear Advanced (Optional)");
  const weightProfile = new TextInputBuilder()
    .setCustomId("weightProfile")
    .setLabel("Weight profile (growth/combat/future/unw)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("growth")
    .setValue(defaults.weightSettings?.profile || "");
  const amplification = new TextInputBuilder()
    .setCustomId("amplification")
    .setLabel("Amplification factor (1.0-2.0)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("1.25")
    .setValue(
      Number.isFinite(Number(defaults.weightSettings?.scalingAmplifier))
        ? String(defaults.weightSettings.scalingAmplifier)
        : ""
    );
  const troopTypeFilter = new TextInputBuilder()
    .setCustomId("troopTypeFilter")
    .setLabel("Troop filter (all/inf/cav/arch)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("all")
    .setValue(defaults.troopTypeFilter || "");
  const optimizationMode = new TextInputBuilder()
    .setCustomId("optimizationMode")
    .setLabel("Optimization mode (stats/events)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("stats")
    .setValue(defaults.optimizationMode || "");
  const maxUpgrades = new TextInputBuilder()
    .setCustomId("maxUpgrades")
    .setLabel("Max upgrades (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("100")
    .setValue(Number.isFinite(Number(defaults.maxUpgrades)) ? String(defaults.maxUpgrades) : "");
  modal.addComponents(
    new ActionRowBuilder().addComponents(weightProfile),
    new ActionRowBuilder().addComponents(amplification),
    new ActionRowBuilder().addComponents(troopTypeFilter),
    new ActionRowBuilder().addComponents(optimizationMode),
    new ActionRowBuilder().addComponents(maxUpgrades)
  );
  return modal;
}

async function handleGovGearModalStep1(interaction, requestId) {
  const pending = govGearModalSessions.get(requestId);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({ content: "This panel session expired. Type `Hero gear` again.", flags: MessageFlags.Ephemeral });
    return;
  }
  const fields = ["hat", "chain", "shirt", "pants", "ring"];
  for (const key of fields) {
    const value = normalizeGovGearLevel(interaction.fields.getTextInputValue(key));
    if (!value) {
      await interaction.reply({
        content: `Invalid ${key} level. Example: \`Blue⭐⭐\`, \`Gold T2⭐\`, \`Red T6⭐⭐⭐\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    pending.data[key] = value;
  }
  govGearModalSessions.set(requestId, pending);
  const continueBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:openmodal2:${requestId}`)
    .setLabel("Continue Panel 2")
    .setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder().addComponents(continueBtn);
  await interaction.reply({
    content: "Panel 1 saved. Click to open Panel 2 (Baton + resources).",
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleGovGearModalStep2(interaction, requestId) {
  const pending = govGearModalSessions.get(requestId);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({ content: "This panel session expired. Type `Hero gear` again.", flags: MessageFlags.Ephemeral });
    return;
  }
  const satin = Number(interaction.fields.getTextInputValue("satin"));
  const gildedThreads = Number(interaction.fields.getTextInputValue("gildedThreads"));
  const artisansVision = Number(interaction.fields.getTextInputValue("artisansVision"));
  if (
    !Number.isFinite(satin) ||
    !Number.isFinite(gildedThreads) ||
    !Number.isFinite(artisansVision) ||
    satin < 0 ||
    gildedThreads < 0 ||
    artisansVision < 0
  ) {
    await interaction.reply({ content: "Resource fields must be non-negative numbers.", flags: MessageFlags.Ephemeral });
    return;
  }
  pending.data.satin = Math.floor(satin);
  pending.data.gildedThreads = Math.floor(gildedThreads);
  pending.data.artisansVision = Math.floor(artisansVision);
  rememberUserGovGearMemory(interaction.user.id, pending.data);
  govGearModalSessions.set(requestId, pending);

  const submitBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:submitpanel:${requestId}`)
    .setLabel("Submit Now")
    .setStyle(ButtonStyle.Primary);
  const advancedBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:openadvanced:${requestId}`)
    .setLabel("Advanced (Optional)")
    .setStyle(ButtonStyle.Secondary);
  const cancelBtn = new ButtonBuilder()
    .setCustomId(`optimizegovgear:cancel:${requestId}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Danger);
  await interaction.reply({
    content: "Resources saved. Submit now or open optional advanced settings.",
    components: [new ActionRowBuilder().addComponents(submitBtn, advancedBtn, cancelBtn)],
    flags: MessageFlags.Ephemeral,
  });
}

async function askNextGovGearChatStep(message, sessionKey) {
  const session = govGearChatSessions.get(sessionKey);
  if (!session) return;
  const step = GOV_GEAR_CHAT_STEPS[session.stepIndex];
  if (!step) return;
  await message.reply(step.prompt);
}

async function finishGovGearChatWizard(message, sessionKey, session) {
  await message.reply("Submitting your data to optimizer...");
  rememberUserGovGearMemory(message.author.id, session.data);
  const result = await fetchGovernorGearOptimization(session.data);
  govGearChatSessions.delete(sessionKey);

  if (!result.ok) {
    await message.reply(
      `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/governor-gear/optimize>`
    );
    return;
  }

  const recommendationText = buildOptimizerResultText(result.data);
  await message.reply(
    `Optimizer recommendation:\n${recommendationText}\n\nSource: <https://kingshotoptimizer.com/governor-gear/optimize>`
  );
}

async function submitGovGearModalSession(interaction, requestId) {
  const pending = govGearModalSessions.get(requestId);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({
      content: "This panel session expired. Type `Hero gear` again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  rememberUserGovGearMemory(interaction.user.id, pending.data);
  govGearModalSessions.delete(requestId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await fetchGovernorGearOptimization(pending.data);
  if (!result.ok) {
    await interaction.editReply(
      `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/governor-gear/optimize>`
    );
    return;
  }
  const recommendationText = buildOptimizerResultText(result.data);
  await interaction.editReply(
    `Optimizer recommendation:\n${recommendationText}\n\nSource: <https://kingshotoptimizer.com/governor-gear/optimize>`
  );
}

async function handleGovGearChatMessage(message) {
  if (!message.content) return;
  const sessionKey = getGovGearChatSessionKey(message);
  const existing = govGearChatSessions.get(sessionKey);

  if (!existing) {
    const normalized = normalizeTriggerText(message.content);
    if (!GOV_GEAR_CHAT_TRIGGER_PHRASES.has(normalized)) return;
    const requestId = `${message.author.id}-${Date.now()}`;
    const lastMemory = getUserGovGearMemory(message.author.id) || {};
    govGearModalSessions.set(requestId, { userId: message.author.id, data: { ...lastMemory }, createdAt: Date.now() });
    const openButton = new ButtonBuilder()
      .setCustomId(`optimizegovgear:startselect:${requestId}`)
      .setLabel("Open Governor Gear Panel")
      .setStyle(ButtonStyle.Primary);
    const buttons = [openButton];
    if (hasCompleteGearData(lastMemory)) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`optimizegovgear:reviewsaved:${requestId}`)
          .setLabel("Review saved gear")
          .setStyle(ButtonStyle.Secondary)
      );
    }
    const row = new ActionRowBuilder().addComponents(...buttons);
    await message.reply({
      content:
        "Governor Gear panel is ready.\n" +
        "• **Open Governor Gear Panel** — pick all 6 slots (or start from scratch).\n" +
        (hasCompleteGearData(lastMemory)
          ? "• **Review saved gear** — see your last 6 pieces, change any slot, then resources.\n"
          : "") +
        "You will enter resources in the next step.",
      components: [row],
    });
    return;
  }

  const normalized = normalizeTriggerText(message.content);
  if (GOV_GEAR_CHAT_CANCEL_PHRASES.has(normalized)) {
    govGearChatSessions.delete(sessionKey);
    await message.reply("Governor Gear wizard cancelled.");
    return;
  }

  const step = GOV_GEAR_CHAT_STEPS[existing.stepIndex];
  if (!step) {
    govGearChatSessions.delete(sessionKey);
    return;
  }

  if (step.type === "number") {
    const value = Number(message.content.trim());
    if (!Number.isFinite(value) || value < 0) {
      await message.reply("Please enter a valid non-negative number.");
      await askNextGovGearChatStep(message, sessionKey);
      return;
    }
    existing.data[step.key] = Math.floor(value);
  } else if (step.type === "gear") {
    const level = normalizeGovGearLevel(message.content);
    if (!level) {
      await message.reply("Invalid level. Example values: `Blue⭐⭐`, `Gold T2⭐`, `Red T6⭐⭐⭐`.");
      await askNextGovGearChatStep(message, sessionKey);
      return;
    }
    existing.data[step.key] = level;
  }

  existing.stepIndex += 1;
  govGearChatSessions.set(sessionKey, existing);

  if (existing.stepIndex >= GOV_GEAR_CHAT_STEPS.length) {
    await finishGovGearChatWizard(message, sessionKey, existing);
    return;
  }

  await askNextGovGearChatStep(message, sessionKey);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  presence: {
    status: "online",
    activities: [{ name: "/kingshot /kvkmatches /kingdomage /optimizegovgear", type: ActivityType.Watching }],
  },
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== "optimizegovgear") return;
    const focused = interaction.options.getFocused(true);
    const q = String(focused.value || "").trim().toLowerCase().replace(/\s+/g, "");
    const choices = GOV_GEAR_LEVELS.filter((v) => v.toLowerCase().replace(/\s+/g, "").includes(q))
      .slice(0, 25)
      .map((v) => ({ name: v, value: v }));
    await interaction.respond(choices);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("optimizegovgear:submit:")) {
      await handleGovGearSubmitButton(interaction);
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:startselect:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:startselect:");
      if (!requestId) return;
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (hasCompleteGearData(pending.data)) {
        const review = buildSavedGearReviewView(requestId, pending.data);
        await interaction.reply({
          content: review.content,
          components: review.components,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const view = buildGovGearSelectView(requestId, 0, 0);
      await interaction.reply({
        content: view.content,
        components: view.components,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:reviewsaved:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:reviewsaved:");
      if (!requestId) return;
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!hasCompleteGearData(pending.data)) {
        await interaction.reply({
          content: "No complete saved gear yet. Use **Open Governor Gear Panel** to pick all six slots once.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const review = buildSavedGearReviewView(requestId, pending.data);
      await interaction.reply({
        content: review.content,
        components: review.components,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:editslot:")) {
      const prefix = "optimizegovgear:editslot:";
      const rest = interaction.customId.slice(prefix.length);
      const lastColon = rest.lastIndexOf(":");
      const requestId = rest.slice(0, lastColon);
      const slotIndex = Number(rest.slice(lastColon + 1));
      if (
        !requestId ||
        lastColon < 0 ||
        !Number.isFinite(slotIndex) ||
        slotIndex < 0 ||
        slotIndex >= GOV_GEAR_SLOT_STEPS.length
      ) {
        await interaction.reply({ content: "Invalid gear panel control.", flags: MessageFlags.Ephemeral });
        return;
      }
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const slotDef = GOV_GEAR_SLOT_STEPS[slotIndex];
      const currentRaw = pending.data[slotDef.key];
      const windowStart = defaultGovGearEditWindowStart(currentRaw);
      const view = buildGovGearEditSelectView(requestId, slotIndex, windowStart, currentRaw);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:navedit:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const windowStart = Number(parts[4]);
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const slotDefNav = GOV_GEAR_SLOT_STEPS[slotIndex];
      const savedRawNav = slotDefNav ? pending.data[slotDefNav.key] : "";
      const view = buildGovGearEditSelectView(requestId, slotIndex, windowStart, savedRawNav);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:backreview:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:backreview:");
      if (!requestId) return;
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const review = buildSavedGearReviewView(requestId, pending.data);
      await interaction.update({ content: review.content, components: review.components });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:restartwizard:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:restartwizard:");
      if (!requestId) return;
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      for (const s of GOV_GEAR_SLOT_STEPS) {
        delete pending.data[s.key];
      }
      govGearModalSessions.set(requestId, pending);
      const view = buildGovGearSelectView(requestId, 0, 0);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:openmodal2:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:openmodal2:");
      if (!requestId) return;
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.showModal(buildGovGearModalTwo(requestId, pending.data));
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:openadvanced:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:openadvanced:");
      if (!requestId) return;
      const pendingPanel = govGearModalSessions.get(requestId);
      if (pendingPanel) {
        if (pendingPanel.userId !== interaction.user.id) {
          await interaction.reply({ content: "Only the command owner can edit advanced settings.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.showModal(buildGovGearAdvancedModal(requestId, pendingPanel.data));
        return;
      }
      const pendingSlash = pendingGovGearSubmissions.get(requestId);
      if (pendingSlash) {
        if (pendingSlash.userId !== interaction.user.id) {
          await interaction.reply({ content: "Only the command owner can edit advanced settings.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.showModal(buildGovGearAdvancedModal(requestId, pendingSlash.data));
        return;
      }
      await interaction.reply({ content: "This request expired. Please start again.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:submitpanel:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:submitpanel:");
      if (!requestId) return;
      await submitGovGearModalSession(interaction, requestId);
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:nav:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const page = Number(parts[4]);
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const view = buildGovGearSelectView(requestId, slotIndex, page);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:cancel:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:cancel:");
      if (!requestId) return;
      govGearModalSessions.delete(requestId);
      await interaction.update({ content: "Governor Gear panel cancelled.", components: [] });
      return;
    }
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("optimizegovgear:pick:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
      if (!slot) {
        await interaction.reply({ content: "Invalid panel state. Start again with `Hero gear`.", flags: MessageFlags.Ephemeral });
        return;
      }
      pending.data[slot.key] = interaction.values[0];
      govGearModalSessions.set(requestId, pending);

      const nextSlotIndex = slotIndex + 1;
      if (nextSlotIndex < GOV_GEAR_SLOT_STEPS.length) {
        const view = buildGovGearSelectView(requestId, nextSlotIndex, 0);
        await interaction.update({ content: view.content, components: view.components });
        return;
      }

      const continueBtn = new ButtonBuilder()
        .setCustomId(`optimizegovgear:openmodal2:${requestId}`)
        .setLabel("Continue to Resources")
        .setStyle(ButtonStyle.Primary);
      const cancelBtn = new ButtonBuilder()
        .setCustomId(`optimizegovgear:cancel:${requestId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger);
      await interaction.update({
        content: "All 6 gear slots selected. Click below to enter resources.",
        components: [new ActionRowBuilder().addComponents(continueBtn, cancelBtn)],
      });
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:pickedit:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `Hero gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
      if (!slot) {
        await interaction.reply({ content: "Invalid panel state. Start again with `Hero gear`.", flags: MessageFlags.Ephemeral });
        return;
      }
      pending.data[slot.key] = interaction.values[0];
      govGearModalSessions.set(requestId, pending);
      if (hasCompleteGearData(pending.data)) {
        rememberUserGovGearMemory(interaction.user.id, pending.data);
      }
      const review = buildSavedGearReviewView(requestId, pending.data);
      await interaction.update({ content: review.content, components: review.components });
      return;
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("optimizegovgear:modal1:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:modal1:");
      if (!requestId) return;
      await handleGovGearModalStep1(interaction, requestId);
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:modal2:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:modal2:");
      if (!requestId) return;
      await handleGovGearModalStep2(interaction, requestId);
      return;
    }
    if (interaction.customId.startsWith("optimizegovgear:modaladvanced:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizegovgear:modaladvanced:");
      if (!requestId) return;
      const parsed = parseGovernorAdvancedSettingsFromFields(interaction.fields);
      if (!parsed.ok) {
        await interaction.reply({ content: parsed.message, flags: MessageFlags.Ephemeral });
        return;
      }

      const pendingPanel = govGearModalSessions.get(requestId);
      if (pendingPanel && pendingPanel.userId === interaction.user.id) {
        pendingPanel.data = { ...pendingPanel.data, ...parsed.settings };
        govGearModalSessions.set(requestId, pendingPanel);
        const submitBtn = new ButtonBuilder()
          .setCustomId(`optimizegovgear:submitpanel:${requestId}`)
          .setLabel("Submit Now")
          .setStyle(ButtonStyle.Primary);
        await interaction.reply({
          content: "Advanced settings saved. Click Submit Now.",
          components: [new ActionRowBuilder().addComponents(submitBtn)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const pendingSlash = pendingGovGearSubmissions.get(requestId);
      if (pendingSlash && pendingSlash.userId === interaction.user.id) {
        pendingSlash.data = { ...pendingSlash.data, ...parsed.settings };
        pendingGovGearSubmissions.set(requestId, pendingSlash);
        await interaction.reply({
          content: "Advanced settings saved. Return to your slash message and click Submit.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({ content: "This request expired. Please start again.", flags: MessageFlags.Ephemeral });
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!["kingshot", "kvkmatches", "kingdomage", "optimizegovgear"].includes(interaction.commandName)) return;

  await interaction.deferReply({ flags: interaction.commandName === "optimizegovgear" ? MessageFlags.Ephemeral : undefined });

  try {
    if (interaction.commandName === "kingshot") {
      await handleKingshot(interaction);
      return;
    }
    if (interaction.commandName === "kvkmatches") {
      await handleKvkMatches(interaction);
      return;
    }
    if (interaction.commandName === "kingdomage") {
      await handleKingdomAge(interaction);
      return;
    }
    await handleOptimizeGovGear(interaction);
  } catch (e) {
    console.error("Command handling error:", e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Unexpected error while processing the command.");
    } else {
      await interaction.reply({
        content: "Unexpected error while processing the command.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  try {
    await handleGovGearChatMessage(message);
  } catch (e) {
    console.error("Gov gear chat wizard error:", e);
    await message.reply("Unexpected error while processing the Hero gear wizard.");
  }
});

client.login(token);
