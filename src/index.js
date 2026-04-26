require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  EmbedBuilder,
  AttachmentBuilder,
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
  fetchKvkSourceRanksForKingdom,
  fetchKvkExtendedRanksForKingdom,
  fetchKingdomTrackerById,
  fetchTransferWindows,
  fetchTransferHistoryForKingdom,
  fetchGovernorGearOptimization,
  fetchCharmsOptimization,
  CHARM_LEVEL_API_KEYS,
} = require("./kingshot-api");

/** Parallel to `CHARM_LEVEL_API_KEYS` — slash option descriptions (max 100 chars each). */
const CHARM_SLASH_LEVEL_LABELS = [
  "Cavalry gear 1 — charm 1",
  "Cavalry gear 1 — charm 2",
  "Cavalry gear 1 — charm 3",
  "Cavalry gear 2 — charm 1",
  "Cavalry gear 2 — charm 2",
  "Cavalry gear 2 — charm 3",
  "Infantry gear 1 — charm 1",
  "Infantry gear 1 — charm 2",
  "Infantry gear 1 — charm 3",
  "Infantry gear 2 — charm 1",
  "Infantry gear 2 — charm 2",
  "Infantry gear 2 — charm 3",
  "Archery gear 1 — charm 1",
  "Archery gear 1 — charm 2",
  "Archery gear 1 — charm 3",
  "Archery gear 2 — charm 1",
  "Archery gear 2 — charm 2",
  "Archery gear 2 — charm 3",
];

const CHARMS_CLOTHS = [
  {
    key: "cloth1",
    label: "Hat (calv1)",
    charmKeys: ["cavalry_gear_1_charm_1", "cavalry_gear_1_charm_2", "cavalry_gear_1_charm_3"],
  },
  {
    key: "cloth2",
    label: "Pendant (calv2)",
    charmKeys: ["cavalry_gear_2_charm_1", "cavalry_gear_2_charm_2", "cavalry_gear_2_charm_3"],
  },
  {
    key: "cloth3",
    label: "Shirt (inf1)",
    charmKeys: ["infantry_gear_1_charm_1", "infantry_gear_1_charm_2", "infantry_gear_1_charm_3"],
  },
  {
    key: "cloth4",
    label: "Pants (inf2)",
    charmKeys: ["infantry_gear_2_charm_1", "infantry_gear_2_charm_2", "infantry_gear_2_charm_3"],
  },
  {
    key: "cloth5",
    label: "Ring (arch1)",
    charmKeys: ["archery_gear_1_charm_1", "archery_gear_1_charm_2", "archery_gear_1_charm_3"],
  },
  {
    key: "cloth6",
    label: "Baton (arch2)",
    charmKeys: ["archery_gear_2_charm_1", "archery_gear_2_charm_2", "archery_gear_2_charm_3"],
  },
];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID || "";
const brandImageUrl = process.env.BRAND_IMAGE_URL || "";
const localBrandImagePath = path.join(__dirname, "..", "img", "pazam.png");
const localBrandImageName = "pazam.png";
const nicknameChannelId = (process.env.NICKNAME_CHANNEL_ID || "").trim();
const enableNicknameChannel = Boolean(nicknameChannelId);
const gameChannelId = (process.env.GAME_CHANNEL_ID || "").trim();
const sourceChannelId = (process.env.SOURCE_CHANNEL_ID || "1438443128045436979").trim();
const nicknameCooldownSec = Math.max(
  0,
  Number.parseInt(String(process.env.NICKNAME_COOLDOWN_SECONDS || "60"), 10) || 0
);
const nicknameDeleteMessage =
  String(process.env.NICKNAME_DELETE_MESSAGE || "").toLowerCase() === "true";
/** @type {Map<string, number>} */
const nicknameCooldownUntil = new Map();

/** If set, optimizer slash commands, gov-gear autocomplete, gov/charms chat wizards,
and gov-gear panel UI can be restricted by guild and/or channel.
Supports comma-separated `GOV_GEAR_GUILD_IDS` + `GOV_GEAR_CHANNEL_IDS`;
legacy singular keys still work. */
const govGearGuildIds = Array.from(
  new Set(
    String(process.env.GOV_GEAR_GUILD_IDS || process.env.GOV_GEAR_GUILD_ID || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  )
);
const govGearChannelIds = Array.from(
  new Set(
    String(process.env.GOV_GEAR_CHANNEL_IDS || process.env.GOV_GEAR_CHANNEL_ID || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  )
);
const restrictGovGearToGuild = govGearGuildIds.length > 0;
const restrictGovGearToChannel = govGearChannelIds.length > 0;

function isGovGearAllowedContext(guildId, channelId) {
  if (restrictGovGearToGuild) {
    if (!guildId) return false;
    if (!govGearGuildIds.includes(String(guildId))) return false;
  }
  if (restrictGovGearToChannel) {
    if (!govGearChannelIds.includes(String(channelId || ""))) return false;
  }
  return true;
}

function formatGovGearAllowedTargetMention() {
  const guildPart = govGearGuildIds.length
    ? `server ID(s): ${govGearGuildIds.join(", ")}`
    : "";
  const channelPart = govGearChannelIds.length
    ? `channel(s): ${govGearChannelIds.map((id) => `<#${id}>`).join(", ")}`
    : "";
  if (guildPart && channelPart) return `${guildPart} • ${channelPart}`;
  if (guildPart) return guildPart;
  if (channelPart) return channelPart;
  return "this server";
}

/** @param {import("discord.js").BaseInteraction} interaction */
async function replyGovGearWrongChannel(interaction) {
  const content = `Optimizer commands are only available in ${formatGovGearAllowedTargetMention()}.`;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* ignore */
  }
}

function getDiscordApiErrorCode(error) {
  const raw = error?.code ?? error?.rawError?.code;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** Expired token / old component (10062) or duplicate ack race (40060). */
function isIgnorableInteractionResponseError(error) {
  const code = getDiscordApiErrorCode(error);
  if (code === 10062 || code === 40060) return true;
  const msg = String(error?.message || error?.rawError?.message || "");
  return msg.includes("Unknown interaction") || msg.includes("already been acknowledged");
}

if (!token || !clientId) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
  process.exit(1);
}

const optimizeCharmsSlash = new SlashCommandBuilder()
  .setName("optimizecharms")
  .setDescription("Charm upgrade plan (Kingshot Optimizer)")
  .addIntegerOption((o) =>
    o.setName("charm_guides").setDescription("Available Charm Guides").setRequired(true).setMinValue(0)
  )
  .addIntegerOption((o) =>
    o.setName("charm_designs").setDescription("Available Charm Designs").setRequired(true).setMinValue(0)
  );
for (let i = 0; i < CHARM_LEVEL_API_KEYS.length; i++) {
  const key = CHARM_LEVEL_API_KEYS[i];
  const label = CHARM_SLASH_LEVEL_LABELS[i] || key;
  optimizeCharmsSlash.addIntegerOption((o) =>
    o
      .setName(key)
      .setDescription(label.length > 100 ? `${label.slice(0, 97)}...` : label)
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(22)
  );
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
    .setName("transfers")
    .setDescription("Show past and upcoming kingdom transfer windows")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Optional kingdom ID for last-leading transfer hint")
        .setRequired(false)
        .setMinValue(1)
    ),
  new SlashCommandBuilder().setName("quote").setDescription("מי אמר את זה?"),
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
  optimizeCharmsSlash,
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
const charmsPanelSessions = new Map();
const govGearModalSessions = new Map();
const GOV_GEAR_MEMORY_FILE = path.resolve(__dirname, "..", "data", "govgear-user-memory.json");
const CHARMS_MEMORY_FILE = path.resolve(__dirname, "..", "data", "charms-user-memory.json");
const GOV_GEAR_CHAT_TRIGGER_PHRASES = new Set([
  "gov gear",
  "government gear",
  "goverment gear",
  "גוב גיר",
  "גוברמנט גיר",
]);
/** Whole message (after `normalizeTriggerText`) must match — starts charms chat wizard. */
const CHARMS_CHAT_TRIGGER_PHRASES = new Set(["charms", "charm", "צארמ", "צארמס"]);
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
const GOV_GEAR_SLOT_COUNT = GOV_GEAR_SLOT_STEPS.length;

function govGearSlotStepLine(slotIndex) {
  const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
  const label = slot ? slot.label : "Gear";
  const step = Number.isFinite(slotIndex)
    ? Math.min(Math.max(Math.floor(slotIndex) + 1, 1), GOV_GEAR_SLOT_COUNT)
    : 1;
  return `**Step ${step}/${GOV_GEAR_SLOT_COUNT}** — ${label}`;
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

/**
 * Build a server nickname: display name + " #<kingdomId>" (max 32 chars for Discord).
 * If the name already ends with "#<digits>", replace that suffix with the new kingdom id.
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
  if (/(?:\s+)?#\d+$/.test(base)) {
    base = base.replace(/(?:\s+)?#\d+$/, "").trim();
  }
  if (!base) base = "member";
  if (base.length > maxBase) base = base.slice(0, maxBase);
  return `${base}${suffix}`;
}

/** @param {import("discord.js").Message} message */
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

function getKingdomOpenTimeDate(data) {
  const raw =
    data.openTime ??
    data.open_time ??
    data.open_at ??
    data.openAt ??
    data.create_time ??
    data.createTime;
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildKingdomAgePazamEmbed(data) {
  const openDate = getKingdomOpenTimeDate(data);
  const kingdomId = data.kingdomId ?? data.kingdom_id;
  const pazam = openDate ? formatMonthsDaysFromDate(openDate) : "Unknown";
  const openTimeStr = openDate ? formatOpenDate(openDate) : "Unknown";
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`פז\"מ של השרת #${kingdomId}`)
    .setDescription(`🕒 ${pazam}\n📅 ${openTimeStr}`)
    .setFooter({ text: "Source: kingshot.net/api/kingdom-tracker" });
  return applyBrandThumbnail(embed);
}

function normalizePlayerApiRow(data, fallbackId) {
  const id = pickPlayerIdValue(data) ?? fallbackId;
  const kingdomNum = data.kingdomId ?? data.kingdom_id ?? data.serverId ?? data.server_id;
  let kingdom = "—";
  if (data.kingdom != null && String(data.kingdom).trim()) kingdom = String(data.kingdom).trim();
  else if (kingdomNum != null && Number.isFinite(Number(kingdomNum))) kingdom = `#${kingdomNum}`;
  else if (kingdomNum != null) kingdom = String(kingdomNum);

  const level = data.level ?? data.castleLevel ?? data.castle_level;
  const levelRenderedDetailed =
    data.levelRenderedDetailed ||
    data.level_rendered_detailed ||
    (level != null && level !== "" ? `Level ${level}` : undefined);

  const name = data.name || data.nickname || data.nickName || "Player";

  const pickUrl = (v) => {
    const s = v == null ? "" : String(v).trim();
    return /^https?:\/\//i.test(s) ? s : null;
  };
  const profilePhoto =
    pickUrl(data.profilePhoto) ||
    pickUrl(data.profile_photo) ||
    pickUrl(data.avatar) ||
    pickUrl(data.avatarUrl) ||
    pickUrl(data.profileImage) ||
    pickUrl(data.image);

  const levelImage =
    pickUrl(data.levelImage) || pickUrl(data.level_image) || pickUrl(data.levelImageUrl);

  return {
    name,
    playerId: id,
    kingdom,
    level,
    levelRenderedDetailed,
    profilePhoto,
    levelImage,
  };
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

    let perspective = "UNKNOWN";
    if (Number.isFinite(Number(options.kingdomId))) {
      const k = Number(options.kingdomId);
      const isParticipant = Number(m.kingdom_a) === k || Number(m.kingdom_b) === k;
      const prepWinnerNum = Number(m.prep_winner);
      const castleWinnerNum = Number(m.castle_winner);
      const prepKnown = Number.isFinite(prepWinnerNum) && prepWinnerNum > 0;
      const castleKnown = Number.isFinite(castleWinnerNum) && castleWinnerNum > 0;
      if (isParticipant && prepKnown && castleKnown) {
        const prepWin = prepWinnerNum === k;
        const castleWin = castleWinnerNum === k;
        if (prepWin && castleWin) perspective = "WIN";
        else if (!prepWin && !castleWin) perspective = "LOSS";
        else perspective = "SPLIT";
      } else if (isParticipant && castleKnown) {
        perspective = castleWinnerNum === k ? "WIN" : "LOSS";
      }
    }

    const resultBadge =
      perspective === "WIN"
        ? "🟢 WIN"
        : perspective === "LOSS"
          ? "🔴 LOSS"
          : perspective === "SPLIT"
            ? "🟠 SPLIT"
            : "⚪ UNKNOWN";
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
  const hasAtlasSource = sortedMatches.some((m) => String(m.source || "").toLowerCase() === "atlas");
  const sourceFooter = hasAtlasSource
    ? "Source: kingshot.net/api/kvk/matches + ks-atlas.com"
    : "Source: kingshot.net/api/kvk/matches";
  const embeds = limitedChunks.map((chunkCards, idx) => {
    const titleSuffix = limitedChunks.length > 1 ? ` (Part ${idx + 1}/${limitedChunks.length})` : "";
    const summary = `📊 **Summary** • Matches: **${total}** • Wins: **${wins}** • Losses: **${losses}** • Win Rate: **${winRate}%**`;
    const embed = new EmbedBuilder()
      .setColor(wins >= losses ? 0x2ecc71 : 0xe67e22)
      .setTitle(`Kingshot KVK Matches (${total})${titleSuffix}`)
      .setDescription(idx === 0 ? summary : "More records:")
      .setFooter({ text: sourceFooter });

    if (idx === 0 && options.kingdomId !== undefined) {
      embed.addFields({ name: "Kingdom", value: `#${options.kingdomId}`, inline: false });
      if (options.ranks) {
        const optRank =
          options.ranks.kingshotOptimizerRank != null ? options.ranks.kingshotOptimizerRank : "Loading...";
        const atlasRank =
          options.ranks.kingshotAtlasRank != null ? options.ranks.kingshotAtlasRank : "Loading...";
        embed.addFields({
          name: "Ranks",
          value: [
            `• Rank at kingshot.net: **${options.ranks.kingshotNetRank ?? "N/A"}**`,
            `• Rank at kingshot optimizer: **${optRank}**`,
            `• Rank at kingshot atlas: **${atlasRank}**`,
          ].join("\n"),
          inline: false,
        });
      }
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

function hasActiveCharmsPanelSessionForMessage(message) {
  for (const session of charmsPanelSessions.values()) {
    if (session.userId === message.author.id && session.channelId === message.channelId) {
      return true;
    }
  }
  return false;
}

function clearCharmsPanelSessionsForMessage(message) {
  for (const [requestId, session] of charmsPanelSessions.entries()) {
    if (session.userId === message.author.id && session.channelId === message.channelId) {
      charmsPanelSessions.delete(requestId);
    }
  }
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

function loadCharmsMemoryStore() {
  try {
    if (!fs.existsSync(CHARMS_MEMORY_FILE)) return {};
    const raw = fs.readFileSync(CHARMS_MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveCharmsMemoryStore(store) {
  try {
    const dir = path.dirname(CHARMS_MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHARMS_MEMORY_FILE, JSON.stringify(store, null, 2), "utf8");
  } catch (_) {
    // ignore persistence failures
  }
}

function getUserCharmsMemory(userId) {
  const store = loadCharmsMemoryStore();
  const value = store[String(userId)];
  if (!value || typeof value !== "object") return null;
  return value.data && typeof value.data === "object" ? value.data : null;
}

function rememberUserCharmsMemory(userId, data) {
  const store = loadCharmsMemoryStore();
  store[String(userId)] = {
    updatedAt: new Date().toISOString(),
    data,
  };
  saveCharmsMemoryStore(store);
}

function parseRequestIdFromCustomId(customId, expectedPrefix) {
  if (!customId.startsWith(expectedPrefix)) return null;
  return customId.slice(expectedPrefix.length);
}

/** Optimizer API `weightSettings.profile` values (API removed legacy `futureProofed`; use `gen4NewNormal`). */
const GOV_GEAR_WEIGHT_PROFILE_API_IDS = [
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
];

function resolveGovGearWeightProfileFromModalInput(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const key = trimmed.replace(/\s+/g, "").toLowerCase();
  /** Shorthand checked first so `combat` means early-game combat, not API profile `combat`. */
  const shorthand = {
    growth: "earlyGameGrowth",
    earlygamegrowth: "earlyGameGrowth",
    combat: "earlyGameCombat",
    earlygamecombat: "earlyGameCombat",
    future: "gen4NewNormal",
    futureproofed: "gen4NewNormal",
    gen4: "gen4NewNormal",
    gen4newnormal: "gen4NewNormal",
    balance: "balance",
    unweighted: "unweighted",
    unw: "unweighted",
    globalcombat: "combat",
  };
  if (shorthand[key]) return shorthand[key];
  const exact = GOV_GEAR_WEIGHT_PROFILE_API_IDS.find((p) => p === trimmed);
  if (exact) return exact;
  return GOV_GEAR_WEIGHT_PROFILE_API_IDS.find((p) => p.toLowerCase() === trimmed.toLowerCase()) || null;
}

function parseGovernorAdvancedSettingsFromFields(fields) {
  const profileRaw = String(fields.getTextInputValue("weightProfile") || "").trim();
  const troopRaw = String(fields.getTextInputValue("troopTypeFilter") || "").trim().toLowerCase();
  const troopMap = { all: "all", infantry: "infantry", cavalry: "cavalry", archery: "archery", archer: "archery" };
  const modeRaw = String(fields.getTextInputValue("optimizationMode") || "").trim().toLowerCase();
  const modeMap = { stats: "optimize-stats", events: "optimize-events", "optimize-stats": "optimize-stats", "optimize-events": "optimize-events" };
  const ampRaw = String(fields.getTextInputValue("amplification") || "").trim();
  const maxUpgradesRaw = String(fields.getTextInputValue("maxUpgrades") || "").trim();

  const out = {};
  if (profileRaw) {
    const mapped = resolveGovGearWeightProfileFromModalInput(profileRaw);
    if (!mapped) {
      return {
        ok: false,
        message:
          "Invalid Weight profile. Shortcuts: **growth**, **combat** (early-game), **future** / **gen4** (gen4 meta), **balance**, **unweighted**. You can also paste an API id (e.g. `gen4NewNormal`, `attackTank`).",
      };
    }
    out.weightSettings = { enabled: true, profile: mapped };
  }
  if (ampRaw) {
    const amp = Number(ampRaw);
    if (!Number.isFinite(amp) || amp < 1 || amp > 2) {
      return { ok: false, message: "Amplification factor must be a number between 1.0 and 2.0." };
    }
    out.weightSettings = out.weightSettings || { enabled: true, profile: "gen4NewNormal" };
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
  const gearButton = (i) =>
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:editslot:${requestId}:${i}`)
      .setLabel(shortLabel(GOV_GEAR_SLOT_STEPS[i].label).slice(0, 80))
      .setStyle(ButtonStyle.Secondary);
  // Discord max 5 buttons/row — 6 slots need two rows (here 3+3 so Baton sits with other gear, not with actions).
  const rowGear1 = new ActionRowBuilder().addComponents(gearButton(0), gearButton(1), gearButton(2));
  const rowGear2 = new ActionRowBuilder().addComponents(gearButton(3), gearButton(4), gearButton(5));
  const rowActions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:openmodal2:${requestId}`)
      .setLabel("Continue to resources")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`optimizegovgear:restartwizard:${requestId}`)
      .setLabel("Clear gear & start over")
      .setStyle(ButtonStyle.Danger)
  );
  return { content, components: [rowGear1, rowGear2, rowActions] };
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
      `${govGearSlotStepLine(slotIndex)}\n` +
      `Page **${safePage + 1}/${totalPages}** of tier list (use **Next** for higher tiers like Gold T3 / Red).`,
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

/** Same as wizard select, but updates one slot from saved-gear review (customIds differ). `windowStart` = index into GOV_GEAR_LEVELS for the first row. Options stay in real tier order; `setDefault` marks your save (Discord may scroll to it). */
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
      `${govGearSlotStepLine(slotIndex)} · edit\n` +
      (savedLine || "") +
      `Tiers **${start + 1}–${end}** of **${len}** (progression order; window centered on your save when possible). Your save stays **selected**. **Prev** / **Next** for more tiers.`,
    components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(prevBtn, nextBtn, backBtn)],
  };
}

function formatOptimizerStatBonusPercent(n) {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  const s = rounded.toFixed(2);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function formatOptimizerPower(n) {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

/** Matches kingshotoptimizer API `result`: recommendations length, totalStatGain, totalPowerGain. */
function buildGovernorGearOptimizerSummaryLine(data) {
  if (!data || typeof data !== "object") return "";
  const rec = Array.isArray(data.recommendations) ? data.recommendations : [];
  const upgrades = rec.length;
  const stat = Number(data.totalStatGain);
  const pow = Number(data.totalPowerGain);
  return `**${upgrades}** upgrade${upgrades === 1 ? "" : "s"} · **+${formatOptimizerStatBonusPercent(stat)}%** stat bonus · **+${formatOptimizerPower(pow)}** power`;
}

function buildGovernorGearOptimizerReplyMarkdown(data) {
  const summary = buildGovernorGearOptimizerSummaryLine(data);
  const detail = buildOptimizerResultText(data);
  return `Optimizer recommendation:\n${summary}\n\n${detail}\n\nSource: <https://kingshotoptimizer.com/governor-gear/optimize>`;
}

function buildCharmsOptimizerSummaryLine(data) {
  if (!data || typeof data !== "object") return "";
  const rec = Array.isArray(data.recommendations) ? data.recommendations : [];
  const upgrades = rec.length;
  const stat = Number(data.totalStatGain);
  const pow = Number(data.totalPowerGain);
  const ev = Number(data.totalEventPoints);
  let line = `**${upgrades}** upgrade${upgrades === 1 ? "" : "s"} · **+${formatOptimizerPower(stat)}** total stat gain · **+${formatOptimizerPower(pow)}** power`;
  if (Number.isFinite(ev) && ev > 0) {
    line += ` · **+${formatOptimizerPower(ev)}** event pts`;
  }
  return line;
}

function buildCharmsOptimizerResultText(data) {
  if (!data || typeof data !== "object") return "No optimization details were returned.";
  const rec = Array.isArray(data.recommendations) ? data.recommendations : [];
  if (!rec.length) return "No recommendations returned.";

  const parentPieceLabel = {
    cavalry_gear_1: "Hat (calv1)",
    cavalry_gear_2: "Pendant (calv2)",
    infantry_gear_1: "Shirt (inf1)",
    infantry_gear_2: "Pants (inf2)",
    archery_gear_1: "Ring (arch1)",
    archery_gear_2: "Baton (arch2)",
  };
  const groupOrder = [
    "cavalry_gear_1",
    "cavalry_gear_2",
    "infantry_gear_1",
    "infantry_gear_2",
    "archery_gear_1",
    "archery_gear_2",
  ];

  const parseCharmNumber = (item) => {
    const id = String(item?.charm?.id || "");
    const m = id.match(/_charm_(\d+)$/);
    if (m) return Number(m[1]);
    const name = String(item?.charm?.name || "");
    const n = name.match(/Charm\s*(\d+)/i);
    return n ? Number(n[1]) : Number.POSITIVE_INFINITY;
  };

  const grouped = new Map();
  for (const key of groupOrder) grouped.set(key, []);
  for (const item of rec) {
    const key = item?.charm?.parentPiece || "other";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }

  const sections = [];
  for (const key of [...groupOrder, ...Array.from(grouped.keys()).filter((k) => !groupOrder.includes(k))]) {
    const items = grouped.get(key) || [];
    if (!items.length) continue;
    const byCharm = new Map();
    for (const item of items) {
      const charmId = String(item?.charm?.id || item?.charm?.name || "unknown_charm");
      const from = Number(item?.fromLevel);
      const to = Number(item?.toLevel);
      const statGain = Number(item?.statGain);
      if (!byCharm.has(charmId)) {
        byCharm.set(charmId, {
          item,
          from: Number.isFinite(from) ? from : null,
          to: Number.isFinite(to) ? to : null,
          statGain: Number.isFinite(statGain) ? statGain : 0,
          count: 1,
          charmNumber: parseCharmNumber(item),
        });
      } else {
        const agg = byCharm.get(charmId);
        agg.count += 1;
        if (Number.isFinite(from)) agg.from = agg.from == null ? from : Math.min(agg.from, from);
        if (Number.isFinite(to)) agg.to = agg.to == null ? to : Math.max(agg.to, to);
        if (Number.isFinite(statGain)) agg.statGain += statGain;
      }
    }
    const merged = Array.from(byCharm.values()).sort((a, b) => {
      if (a.charmNumber !== b.charmNumber) return a.charmNumber - b.charmNumber;
      const aFrom = a.from == null ? Number.POSITIVE_INFINITY : a.from;
      const bFrom = b.from == null ? Number.POSITIVE_INFINITY : b.from;
      return aFrom - bFrom;
    });
    const title = parentPieceLabel[key] || key;
    const lines = merged.slice(0, 5).map((entry, idx) => {
      const name = entry.item?.charm?.name || entry.item?.charm?.id || "Charm";
      const shortName = String(name).replace(/^.*Charm\s+/i, "Charm ");
      const from = entry.from ?? "?";
      const to = entry.to ?? "?";
      const sg = entry.statGain > 0 ? ` (+${entry.statGain} stat)` : "";
      const extra = entry.count > 1 ? ` (${entry.count} upgrades)` : "";
      return `${idx + 1}. ${shortName}: Lv ${from} → Lv ${to}${sg}${extra}`;
    });
    const moreInGroup = merged.length > 5 ? `\n… and ${merged.length - 5} more for ${title}.` : "";
    sections.push(`**${title}**\n${lines.join("\n")}${moreInGroup}`);
  }

  const totalMergedCount = Array.from(grouped.values()).reduce((acc, items) => {
    const unique = new Set(items.map((it) => String(it?.charm?.id || it?.charm?.name || "unknown_charm")));
    return acc + unique.size;
  }, 0);
  const shownCount = Array.from(grouped.values()).reduce((acc, items) => {
    const unique = new Set(items.map((it) => String(it?.charm?.id || it?.charm?.name || "unknown_charm")));
    return acc + Math.min(unique.size, 5);
  }, 0);
  const more =
    totalMergedCount > shownCount ? `\n\n… and **${totalMergedCount - shownCount}** more merged entries in total.` : "";
  const hint = data.bottleneckAnalysis?.suggestion ? `\n\n**Note:** ${data.bottleneckAnalysis.suggestion}` : "";
  return `${sections.join("\n\n")}${more}${hint}`;
}

function buildCharmsOptimizerReplyMarkdown(data) {
  const summary = buildCharmsOptimizerSummaryLine(data);
  const detail = buildCharmsOptimizerResultText(data);
  return `Charms optimizer:\n${summary}\n\n${detail}\n\nSource: <https://kingshotoptimizer.com/charms/optimize>`;
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
    for (const item of topArray) {
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

    const groupedValues = Array.from(grouped.values());
    const lines = groupedValues
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
    const hiddenPieceCount = Math.max(0, groupedValues.length - lines.length);
    const pieceNote =
      hiddenPieceCount > 0
        ? `\n… plus ${hiddenPieceCount} more gear piece${hiddenPieceCount === 1 ? "" : "s"}.`
        : "";
    return `${lines.join("\n")}\n\n(Showing grouped plan across all **${topArray.length}** upgrades.)${pieceNote}`;
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

/** Chat shortcuts (plain messages). Returns true if this message was handled. Skipped while governor or charms chat wizard is active. */
async function handlePublicApiShortcuts(message) {
  if (message.author.bot) return false;
  const sessionKey = getGovGearChatSessionKey(message);
  if (govGearChatSessions.has(sessionKey)) return false;
  if (hasActiveCharmsPanelSessionForMessage(message)) return false;

  const text = String(message.content || "").trim();
  if (!text) return false;

  // Kingdom age: פזמ 210 or פז"מ 210 (ASCII " or Hebrew gershayim U+05F4 between ז and מ)
  const ageMatch = text.match(/^פז(?:מ|["\u05F4\u0022]מ)\s+(\d+)\s*$/u);
  if (ageMatch) {
    const kingdomId = parseInt(ageMatch[1], 10);
    if (!Number.isFinite(kingdomId) || kingdomId <= 0) return false;
    const res = await fetchKingdomTrackerById(kingdomId);
    if (!res.ok) {
      await message.reply(res.message || "Could not fetch kingdom tracker data right now.");
      return true;
    }
    await message.reply(buildEmbedReplyPayload([buildKingdomAgePazamEmbed(res.data || {})]));
    return true;
  }

  // Transfers shortcuts: "transfer 210" or "טרנספר 210"
  const transferMatch = text.match(/^(?:transfer|טרנספר)\s+(\d+)\s*$/iu);
  if (transferMatch) {
    const kingdomId = parseInt(transferMatch[1], 10);
    if (!Number.isFinite(kingdomId) || kingdomId <= 0) return false;
    const res = await fetchTransferWindows({ kingdomId });
    if (!res.ok) {
      await message.reply(res.message || "Could not fetch transfer windows right now.");
      return true;
    }
    const hist = await fetchTransferHistoryForKingdom({ kingdomId });
    const content = buildTransferReplyContent({ kingdomId, windowsRes: res, historyRes: hist });
    await message.reply(content);
    return true;
  }

  // KvK: message is only digits, 1–4 digits (e.g. 210). Player IDs use the 5–20 rule below.
  if (/^\d+$/.test(text)) {
    if (text.length >= 5 && text.length <= 20) {
      const playerId = text;
      const res = await fetchPlayerInfo(playerId);
      if (!res.ok) {
        await message.reply(res.message || "Could not fetch player info right now.");
        return true;
      }
      const row = normalizePlayerApiRow(res.data || {}, playerId);
      await message.reply({ embeds: [buildPlayerEmbed(row, playerId)] });
      return true;
    }
    if (text.length >= 1 && text.length <= 4) {
      const kingdomId = parseInt(text, 10);
      if (!Number.isFinite(kingdomId) || kingdomId <= 0) return false;
      const [res, ranksRes] = await Promise.all([
        fetchKvkMatchesForKingdom({ kingdomId }),
        fetchKvkSourceRanksForKingdom({ kingdomId }),
      ]);
      if (!res.ok) {
        await message.reply(res.message || "Could not fetch KvK matches right now.");
        return true;
      }
      const rows = res.data || [];
      if (!rows.length) {
        await message.reply(`No KvK matches found for kingdom #${kingdomId}.`);
        return true;
      }
      const initialRanks = { ...(ranksRes?.data || {}), kingshotOptimizerRank: null, kingshotAtlasRank: null };
      const sent = await message.reply({ embeds: buildKvkMatchesEmbeds(rows, { kingdomId, ranks: initialRanks }, null) });
      fetchKvkExtendedRanksForKingdom({ kingdomId })
        .then((extended) => {
          const merged = { ...initialRanks, ...(extended?.data || {}) };
          return sent.edit({ embeds: buildKvkMatchesEmbeds(rows, { kingdomId, ranks: merged }, null) });
        })
        .catch(() => {
          /* keep fast initial response */
        });
      return true;
    }
  }

  return false;
}

async function handleKingshot(interaction) {
  const playerId = interaction.options.getString("player_id", true).trim();
  if (!/^\d{5,20}$/.test(playerId)) {
    await interaction.editReply({
      content: "Please provide a valid numeric player ID.",
    });
    return;
  }

  const res = await fetchPlayerInfo(playerId);
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch player info right now.",
    });
    return;
  }

  const row = normalizePlayerApiRow(res.data || {}, playerId);
  await interaction.editReply({ embeds: [buildPlayerEmbed(row, playerId)] });
}

async function handleKvkMatches(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    await interaction.editReply({
      content: "Please provide a valid kingdom ID.",
    });
    return;
  }

  const [res, ranksRes] = await Promise.all([
    fetchKvkMatchesForKingdom({ kingdomId }),
    fetchKvkSourceRanksForKingdom({ kingdomId }),
  ]);
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch KvK matches right now.",
    });
    return;
  }

  const rows = res.data || [];
  if (!rows.length) {
    await interaction.editReply({ content: `No KvK matches found for kingdom #${kingdomId}.` });
    return;
  }

  const initialRanks = { ...(ranksRes?.data || {}), kingshotOptimizerRank: null, kingshotAtlasRank: null };
  await interaction.editReply({ embeds: buildKvkMatchesEmbeds(rows, { kingdomId, ranks: initialRanks }, null) });
  fetchKvkExtendedRanksForKingdom({ kingdomId })
    .then((extended) => {
      const merged = { ...initialRanks, ...(extended?.data || {}) };
      return interaction.editReply({ embeds: buildKvkMatchesEmbeds(rows, { kingdomId, ranks: merged }, null) });
    })
    .catch(() => {
      /* keep fast initial response */
    });
}

async function handleKingdomAge(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id", true);
  if (!Number.isFinite(kingdomId) || kingdomId <= 0) {
    await interaction.editReply({
      content: "Please provide a valid kingdom ID.",
    });
    return;
  }

  const res = await fetchKingdomTrackerById(kingdomId);
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch kingdom tracker data right now.",
    });
    return;
  }

  await interaction.editReply(buildEmbedReplyPayload([buildKingdomAgePazamEmbed(res.data || {})]));
}

function parseTransferDateLabel(label) {
  const t = Date.parse(String(label || "").trim());
  return Number.isFinite(t) ? t : NaN;
}

/** Parse date from optimizer window text, e.g. `Transfer 6 – Jun 7, 2026`. */
function parseOptimizerTransferWindowDate(label) {
  const m = String(label || "").match(/[–-]\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
  if (!m) return NaN;
  return Date.parse(m[1]);
}

function buildTransferReplyContent({ kingdomId, windowsRes, historyRes }) {
  let content = `**Transfer history**`;
  if (Number.isFinite(kingdomId) && kingdomId > 0) {
    content += ` for Kingdom #${kingdomId}`;
  }
  content += `\n\n`;

  const now = Date.now();
  const futureLabels = Array.isArray(windowsRes?.data?.future) ? windowsRes.data.future : [];
  const nextOptimizer = futureLabels
    .map((l) => ({ label: l, ts: parseOptimizerTransferWindowDate(l) }))
    .filter((x) => Number.isFinite(x.ts) && x.ts >= now)
    .sort((a, b) => a.ts - b.ts)[0];

  if (nextOptimizer) {
    content += `**Upcoming transfer:** ${nextOptimizer.label}\n`;
    if (Number.isFinite(kingdomId) && kingdomId > 0 && historyRes?.ok) {
      const parts = historyRes.data.participation || [];
      const withTs = parts.map((p) => ({ ...p, _ts: parseTransferDateLabel(p.window) }));
      const futureParts = withTs.filter((p) => Number.isFinite(p._ts) && p._ts >= now);
      let nextPart = null;
      if (futureParts.length) {
        const t0 = nextOptimizer.ts;
        const sameDay = futureParts.find((p) => Math.abs(p._ts - t0) < 86400000);
        nextPart =
          sameDay ||
          futureParts.slice().sort((a, b) => Math.abs(a._ts - t0) - Math.abs(b._ts - t0))[0];
      }
      if (nextPart) {
        content += `**Kingdom #${kingdomId} (this window):** Group ${nextPart.group} (${nextPart.rangeStart}–${nextPart.rangeEnd}) · ${nextPart.progress || "N/A"}\n`;
      } else {
        content += `**Kingdom #${kingdomId} (this window):** group/range not found in transfer history for the next window.\n`;
      }
    } else if (Number.isFinite(kingdomId) && kingdomId > 0) {
      content += `**Kingdom #${kingdomId} (this window):** (transfer history unavailable)\n`;
    }
    content += `\n`;
  } else if (futureLabels.length) {
    content += `**Upcoming transfer:** (date could not be parsed)\n\n`;
  } else if (Number.isFinite(kingdomId) && kingdomId > 0 && historyRes?.ok) {
    const parts = historyRes.data.participation || [];
    const withTs = parts.map((p) => ({ ...p, _ts: parseTransferDateLabel(p.window) }));
    const fp = withTs
      .filter((p) => Number.isFinite(p._ts) && p._ts >= now)
      .sort((a, b) => a._ts - b._ts)[0];
    if (fp) {
      content += `**Upcoming transfer:** ${fp.window}\n`;
      content += `**Kingdom #${kingdomId} (this window):** Group ${fp.group} (${fp.rangeStart}–${fp.rangeEnd}) · ${fp.progress || "N/A"}\n\n`;
    }
  }

  if (historyRes?.ok) {
    const withTs = (historyRes.data.participation || [])
      .map((x) => ({ ...x, _ts: parseTransferDateLabel(x.window) }))
      .filter((x) => Number.isFinite(x._ts));
    const pastRows = withTs.filter((x) => x._ts < now).sort((a, b) => b._ts - a._ts);
    const fmtRow = (x) =>
      `- ${x.window} · Group ${x.group} (${x.rangeStart}–${x.rangeEnd}) · ${x.progress || "N/A"}`;

    content += `**Num of transfers so far:** ${pastRows.length}\n\n`;
    content += `**Past:**\n`;
    content += pastRows.length ? pastRows.map(fmtRow).join("\n") : "- (none)";
  } else {
    content += `**Num of transfers so far:** 0\n\n`;
    content += `**Past:**\n- ${historyRes?.message || "Could not load transfer history."}`;
  }

  if (content.length > 1950) {
    content = `${content.slice(0, 1940)}\n...`;
  }
  return content;
}

async function handleTransfers(interaction) {
  const kingdomId = interaction.options.getInteger("kingdom_id");
  const res = await fetchTransferWindows({ kingdomId: kingdomId ?? undefined });
  if (!res.ok) {
    await interaction.editReply({
      content: res.message || "Could not fetch transfer windows right now.",
    });
    return;
  }
  const hist =
    Number.isFinite(kingdomId) && kingdomId > 0
      ? await fetchTransferHistoryForKingdom({ kingdomId })
      : { ok: true, data: { participation: [], windows: [] } };
  const content = buildTransferReplyContent({ kingdomId, windowsRes: res, historyRes: hist });
  await interaction.editReply({ content });
}

function shuffleArray(items) {
  const arr = Array.from(items || []);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sampleArray(items, count) {
  return shuffleArray(items).slice(0, Math.max(0, count));
}

function isEmojiOnlyText(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const compact = raw.replace(/\s+/g, "");
  if (!compact) return false;
  const withoutCustom = compact.replace(/<a?:\w+:\d+>/g, "");
  const withoutUnicodeEmoji = withoutCustom.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
  return withoutUnicodeEmoji.length === 0;
}

function isValidQuoteContent(content) {
  const text = String(content || "").trim();
  if (!text) return false;
  if (text.length < 3) return false;
  if (text.startsWith("!") || text.startsWith("/")) return false;
  if (isEmojiOnlyText(text)) return false;
  return true;
}

async function resolveQuoteGameOptions(sourceChannel, messages, correctAuthorId) {
  const uniqueById = new Map();
  for (const msg of messages.values()) {
    if (!msg?.author?.id || msg.author.bot) continue;
    if (msg.author.id === correctAuthorId) continue;
    if (!uniqueById.has(msg.author.id)) {
      uniqueById.set(msg.author.id, { id: msg.author.id, username: msg.author.username || "משתמש" });
    }
  }

  let options = sampleArray(Array.from(uniqueById.values()), 3);
  if (options.length >= 3) return options;

  try {
    const guildMembers = await sourceChannel.guild.members.fetch();
    for (const member of guildMembers.values()) {
      const user = member?.user;
      if (!user?.id || user.bot) continue;
      if (user.id === correctAuthorId) continue;
      if (!uniqueById.has(user.id)) {
        uniqueById.set(user.id, { id: user.id, username: user.username || member.displayName || "משתמש" });
      }
      if (uniqueById.size >= 30) break;
    }
    options = sampleArray(Array.from(uniqueById.values()), 3);
  } catch (_) {
    // Best effort fallback only.
  }

  return options;
}

async function resolveDisplayNameInGuild(guild, userId, fallbackName) {
  if (!guild || !userId) return String(fallbackName || "משתמש");
  try {
    const member = await guild.members.fetch(userId);
    const nick = String(member?.displayName || "").trim();
    if (nick) return nick;
  } catch (_) {
    // ignore
  }
  return String(fallbackName || "משתמש");
}

function bidiIsolate(value) {
  return `\u2068${String(value || "").trim()}\u2069`;
}

function buildPublicQuoteResultMessage({ clickerName, selectedName, isCorrect, correctName }) {
  const rlm = "\u200F";
  const firstLine = `${rlm}${bidiIsolate(clickerName)} בחר ב`;
  const secondLine = `${rlm}${bidiIsolate(selectedName)}`;
  const thirdLine = `${rlm}${isCorrect ? "✅ צדק" : "❌ טעה"}`;
  const fourthLine = isCorrect ? "" : `${rlm}הנכון: ${bidiIsolate(correctName)}`;
  return [firstLine, secondLine, thirdLine, fourthLine].filter(Boolean).join("\n");
}

function areAllQuoteButtonsDisabled(message) {
  const rows = Array.isArray(message?.components) ? message.components : [];
  const quoteButtons = [];
  for (const row of rows) {
    for (const comp of row?.components || []) {
      if (typeof comp?.customId === "string" && (comp.customId.startsWith("quotegame:") || comp.customId.startsWith("quotegameimg:"))) {
        quoteButtons.push(comp);
      }
    }
  }
  if (quoteButtons.length === 0) return false;
  return quoteButtons.every((b) => Boolean(b.disabled));
}

function buildDisabledQuoteRows(message) {
  const rows = Array.isArray(message?.components) ? message.components : [];
  const out = [];
  for (const row of rows) {
    const rebuilt = (row?.components || []).map((comp) => {
      const customId = String(comp?.customId || "");
      if (customId.startsWith("quotegame:") || customId.startsWith("quotegameimg:")) {
        return ButtonBuilder.from(comp).setDisabled(true);
      }
      return ButtonBuilder.from(comp);
    });
    out.push(new ActionRowBuilder().addComponents(...rebuilt));
  }
  return out;
}

async function handleQuoteCommand(interaction) {
  if (!gameChannelId || !sourceChannelId) {
    await interaction.reply({ content: "הגדרת המשחק חסרה כרגע. נסה שוב מאוחר יותר 🙏", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.channelId !== gameChannelId) {
    await interaction.reply({ content: "המשחק זמין רק בערוץ הייעודי 🎮", flags: MessageFlags.Ephemeral });
    return;
  }

  let sourceChannel;
  try {
    sourceChannel = await interaction.client.channels.fetch(sourceChannelId);
  } catch (_) {
    sourceChannel = null;
  }
  if (!sourceChannel || !sourceChannel.isTextBased() || typeof sourceChannel.messages?.fetch !== "function") {
    await interaction.reply({ content: "אין גישה לערוץ ההודעות 😅", flags: MessageFlags.Ephemeral });
    return;
  }

  let fetched;
  try {
    fetched = await fetchRecentSourceMessages(sourceChannel, 500);
  } catch (_) {
    await interaction.reply({ content: "אין גישה לערוץ ההודעות 😅", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!fetched || fetched.size < 10) {
    await interaction.reply({ content: "אין מספיק פעילות בערוץ המקור", flags: MessageFlags.Ephemeral });
    return;
  }

  const validMessages = Array.from(fetched.values()).filter((msg) => {
    if (!msg || !msg.author || msg.author.bot) return false;
    return isValidQuoteContent(msg.content);
  });

  if (validMessages.length === 0) {
    await interaction.reply({ content: "אין מספיק הודעות בערוץ המקור 😅", flags: MessageFlags.Ephemeral });
    return;
  }

  const picked = validMessages[Math.floor(Math.random() * validMessages.length)];
  const optionPool = await resolveQuoteGameOptions(sourceChannel, fetched, picked.author.id);
  if (optionPool.length < 3) {
    await interaction.reply({ content: "אין מספיק פעילות בערוץ המקור", flags: MessageFlags.Ephemeral });
    return;
  }

  const options = shuffleArray([
    { id: picked.author.id, username: picked.author.username || "משתמש" },
    ...optionPool.slice(0, 3),
  ]);
  if (new Set(options.map((u) => u.id)).size < 4) {
    await interaction.reply({ content: "אין מספיק פעילות בערוץ המקור", flags: MessageFlags.Ephemeral });
    return;
  }

  for (const opt of options) {
    opt.label = await resolveDisplayNameInGuild(interaction.guild, opt.id, opt.username);
  }

  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...options.slice(i, i + 2).map((u) =>
          new ButtonBuilder()
            .setCustomId(`quotegame:${picked.author.id}:${u.id}`)
            .setLabel(String(u.label || u.username || "משתמש").slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        )
      )
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🧠 מי אמר את זה?")
    .setDescription(`> "${String(picked.content || "").trim()}"`);

  await interaction.reply({ embeds: [embed], components: rows });
}

async function startQuoteGameInMessage(message) {
  if (!gameChannelId || !sourceChannelId) return false;
  if (message.channelId !== gameChannelId) return false;
  const text = String(message.content || "").trim().toLowerCase();
  if (text !== "play" && text !== "שחק") return false;

  let sourceChannel;
  try {
    sourceChannel = await message.client.channels.fetch(sourceChannelId);
  } catch (_) {
    sourceChannel = null;
  }
  if (!sourceChannel || !sourceChannel.isTextBased() || typeof sourceChannel.messages?.fetch !== "function") {
    await message.reply("אין גישה לערוץ ההודעות 😅");
    return true;
  }

  let fetched;
  try {
    fetched = await fetchRecentSourceMessages(sourceChannel, 500);
  } catch (_) {
    await message.reply("אין גישה לערוץ ההודעות 😅");
    return true;
  }

  if (!fetched || fetched.size < 10) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  const validMessages = Array.from(fetched.values()).filter((msg) => {
    if (!msg || !msg.author || msg.author.bot) return false;
    return isValidQuoteContent(msg.content);
  });
  if (validMessages.length === 0) {
    await message.reply("אין מספיק הודעות בערוץ המקור 😅");
    return true;
  }

  const picked = validMessages[Math.floor(Math.random() * validMessages.length)];
  const optionPool = await resolveQuoteGameOptions(sourceChannel, fetched, picked.author.id);
  if (optionPool.length < 3) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  const options = shuffleArray([
    { id: picked.author.id, username: picked.author.username || "משתמש" },
    ...optionPool.slice(0, 3),
  ]);
  if (new Set(options.map((u) => u.id)).size < 4) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  for (const opt of options) {
    opt.label = await resolveDisplayNameInGuild(message.guild, opt.id, opt.username);
  }

  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...options.slice(i, i + 2).map((u) =>
          new ButtonBuilder()
            .setCustomId(`quotegame:${picked.author.id}:${u.id}`)
            .setLabel(String(u.label || u.username || "משתמש").slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        )
      )
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🧠 מי אמר את זה?")
    .setDescription(`> "${String(picked.content || "").trim()}"`);

  await message.reply({ embeds: [embed], components: rows });
  return true;
}

function isImageAttachment(att) {
  const contentType = String(att?.contentType || "").toLowerCase();
  if (contentType.startsWith("image/")) return true;
  const name = String(att?.name || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

async function startImageQuoteGameInMessage(message) {
  if (!gameChannelId || !sourceChannelId) return false;
  if (message.channelId !== gameChannelId) return false;
  const text = String(message.content || "").trim().toLowerCase();
  if (text !== "שחק עם תמונה" && text !== "שחק עם תמונות") return false;

  let sourceChannel;
  try {
    sourceChannel = await message.client.channels.fetch(sourceChannelId);
  } catch (_) {
    sourceChannel = null;
  }
  if (!sourceChannel || !sourceChannel.isTextBased() || typeof sourceChannel.messages?.fetch !== "function") {
    await message.reply("אין גישה לערוץ ההודעות 😅");
    return true;
  }

  let fetched;
  try {
    fetched = await fetchRecentSourceMessages(sourceChannel, 500);
  } catch (_) {
    await message.reply("אין גישה לערוץ ההודעות 😅");
    return true;
  }

  if (!fetched || fetched.size < 10) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  const validImageMessages = Array.from(fetched.values()).filter((msg) => {
    if (!msg || !msg.author || msg.author.bot) return false;
    if (!msg.attachments || msg.attachments.size === 0) return false;
    return Array.from(msg.attachments.values()).some((a) => isImageAttachment(a));
  });
  if (validImageMessages.length === 0) {
    await message.reply("אין מספיק תמונות בערוץ המקור 😅");
    return true;
  }

  const picked = validImageMessages[Math.floor(Math.random() * validImageMessages.length)];
  const pickedImage = Array.from(picked.attachments.values()).find((a) => isImageAttachment(a));
  if (!pickedImage?.url) {
    await message.reply("לא הצלחתי למשוך תמונה תקינה מהערוץ 😅");
    return true;
  }

  const optionPool = await resolveQuoteGameOptions(sourceChannel, fetched, picked.author.id);
  if (optionPool.length < 3) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  const options = shuffleArray([
    { id: picked.author.id, username: picked.author.username || "משתמש" },
    ...optionPool.slice(0, 3),
  ]);
  if (new Set(options.map((u) => u.id)).size < 4) {
    await message.reply("אין מספיק פעילות בערוץ המקור");
    return true;
  }

  for (const opt of options) {
    opt.label = await resolveDisplayNameInGuild(message.guild, opt.id, opt.username);
  }

  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      new ActionRowBuilder().addComponents(
        ...options.slice(i, i + 2).map((u) =>
          new ButtonBuilder()
            .setCustomId(`quotegameimg:${picked.author.id}:${u.id}`)
            .setLabel(String(u.label || u.username || "משתמש").slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        )
      )
    );
  }

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("🖼️ מי שלח את התמונה הזו?").setImage(pickedImage.url);
  await message.reply({ embeds: [embed], components: rows });
  return true;
}

async function fetchRecentSourceMessages(sourceChannel, maxMessages = 500) {
  const max = Math.max(10, Math.min(1000, Number(maxMessages) || 500));
  const all = new Map();
  let before;

  while (all.size < max) {
    const remaining = max - all.size;
    const batchSize = Math.min(100, remaining);
    const batch = await sourceChannel.messages.fetch(before ? { limit: batchSize, before } : { limit: batchSize });
    if (!batch || batch.size === 0) break;
    for (const [id, msg] of batch.entries()) {
      all.set(id, msg);
    }
    if (batch.size < batchSize) break;
    const last = batch.last();
    if (!last?.id || last.id === before) break;
    before = last.id;
  }

  return all;
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

async function handleOptimizeCharms(interaction) {
  const charmGuides = interaction.options.getInteger("charm_guides", true);
  const charmDesigns = interaction.options.getInteger("charm_designs", true);
  const charmLevels = {};
  for (const key of CHARM_LEVEL_API_KEYS) {
    const v = interaction.options.getInteger(key);
    charmLevels[key] = v != null ? v : 0;
  }

  const result = await fetchCharmsOptimization({ charmGuides, charmDesigns, charmLevels });
  if (!result.ok) {
    await interaction.editReply({
      content: `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/charms/optimize>`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let content = buildCharmsOptimizerReplyMarkdown(result.data);
  if (content.length > 2000) {
    content = `${content.slice(0, 1990)}…\n_(truncated — open the site for the full list.)_`;
  }
  await interaction.editReply({ content, flags: MessageFlags.Ephemeral });
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
  try {
    rememberUserGovGearMemory(interaction.user.id, pending.data);
    const result = await fetchGovernorGearOptimization(pending.data);
    pendingGovGearSubmissions.delete(requestId);

    if (!result.ok) {
      await interaction.editReply(
        `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/governor-gear/optimize>`
      );
      return;
    }

    await interaction.editReply(buildGovernorGearOptimizerReplyMarkdown(result.data));
  } catch (e) {
    pendingGovGearSubmissions.delete(requestId);
    if (isIgnorableInteractionResponseError(e)) throw e;
    console.error("Governor gear submit (button) failed:", e);
    try {
      await interaction.editReply({
        content: "Unexpected error while contacting the optimizer. Try again or use <https://kingshotoptimizer.com/governor-gear/optimize>.",
      });
    } catch (_) {
      /* interaction may be gone */
    }
  }
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

const GOV_GEAR_API_PROFILE_TO_MODAL = {
  earlyGameGrowth: "growth",
  earlyGameCombat: "combat",
  gen4NewNormal: "future",
  futureProofed: "future",
  balance: "balance",
  unweighted: "unweighted",
  combat: "combat",
  attackTank: "attackTank",
  extremeInfantry: "extremeInfantry",
  extremeArchery: "extremeArchery",
  extremeCavalry: "extremeCavalry",
  userCustom: "userCustom",
  custom: "custom",
};

function buildGovGearAdvancedModal(requestId, defaults = {}) {
  const modal = new ModalBuilder().setCustomId(`optimizegovgear:modaladvanced:${requestId}`).setTitle("Governor Gear Advanced (Optional)");
  const savedProfileKey = defaults.weightSettings?.profile;
  const weightProfileValue = savedProfileKey
    ? GOV_GEAR_API_PROFILE_TO_MODAL[savedProfileKey] ?? savedProfileKey
    : "future";
  const weightProfile = new TextInputBuilder()
    .setCustomId("weightProfile")
    .setLabel("Weight profile (growth/combat/future/unw)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("future")
    .setValue(weightProfileValue);
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
    await interaction.reply({ content: "This panel session expired. Type `gov gear` again.", flags: MessageFlags.Ephemeral });
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
    content: "**Panel 1/2** — Saved.\n**Panel 2/2** — Click below to open resources.",
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleGovGearModalStep2(interaction, requestId) {
  const pending = govGearModalSessions.get(requestId);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({ content: "This panel session expired. Type `gov gear` again.", flags: MessageFlags.Ephemeral });
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
    content: "**Panel 2/2** — Resources saved. Submit now or open optional advanced settings.",
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

  await message.reply(buildGovernorGearOptimizerReplyMarkdown(result.data));
}

async function submitGovGearModalSession(interaction, requestId) {
  const pending = govGearModalSessions.get(requestId);
  if (!pending || pending.userId !== interaction.user.id) {
    await interaction.reply({
      content: "This panel session expired. Type `gov gear` again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  rememberUserGovGearMemory(interaction.user.id, pending.data);
  govGearModalSessions.delete(requestId);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await fetchGovernorGearOptimization(pending.data);
    if (!result.ok) {
      await interaction.editReply(
        `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/governor-gear/optimize>`
      );
      return;
    }
    await interaction.editReply(buildGovernorGearOptimizerReplyMarkdown(result.data));
  } catch (e) {
    if (isIgnorableInteractionResponseError(e)) throw e;
    console.error("Governor gear submit (panel) failed:", e);
    try {
      await interaction.editReply({
        content: "Unexpected error while contacting the optimizer. Try again or use <https://kingshotoptimizer.com/governor-gear/optimize>.",
      });
    } catch (_) {
      /* interaction may be gone */
    }
  }
}

function charmLevelLabel(level) {
  return `Lv${level}`;
}

function getCharmsPanelSummaryLines(data) {
  const lines = CHARMS_CLOTHS.map((cloth) => {
    const levels = cloth.charmKeys.map((ck) => {
      const lv = Number(data[ck]);
      return Number.isFinite(lv) ? charmLevelLabel(Math.max(1, Math.min(22, lv))) : "—";
    });
    return `• ${cloth.label}: ${levels.join(" / ")}`;
  });
  const guides = Number(data.charmGuides ?? 0);
  const designs = Number(data.charmDesigns ?? 0);
  lines.push("");
  lines.push(`Resources: Charm Guides ${guides} · Charm Designs ${designs}`);
  return lines.join("\n");
}

function hasCompleteCharmsData(data) {
  if (!data || typeof data !== "object") return false;
  if (!Number.isFinite(Number(data.charmGuides)) || Number(data.charmGuides) < 0) return false;
  if (!Number.isFinite(Number(data.charmDesigns)) || Number(data.charmDesigns) < 0) return false;
  return CHARMS_CLOTHS.every((cloth) =>
    cloth.charmKeys.every((ck) => {
      const v = Number(data[ck]);
      return Number.isFinite(v) && v >= 1 && v <= 22;
    })
  );
}

function buildCharmsSavedReviewView(requestId, data) {
  const clothButtons = CHARMS_CLOTHS.map((cloth, i) => {
    const hasValue = cloth.charmKeys.every((ck) => Number.isFinite(Number(data[ck])));
    return new ButtonBuilder()
      .setCustomId(`optimizecharms:editslot:${requestId}:${i}`)
      .setLabel(cloth.label)
      .setStyle(hasValue ? ButtonStyle.Success : ButtonStyle.Secondary);
  });

  const row1 = new ActionRowBuilder().addComponents(clothButtons.slice(0, 3));
  const row2 = new ActionRowBuilder().addComponents(clothButtons.slice(3, 6));
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`optimizecharms:resources:${requestId}`)
      .setLabel("Set Resources")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`optimizecharms:submit:${requestId}`)
      .setLabel("Submit")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`optimizecharms:cancel:${requestId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`optimizecharms:restart:${requestId}`)
      .setLabel("Start from beginning")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content:
      "**Saved charms setup** (tap cloth to edit)\n\n" +
      getCharmsPanelSummaryLines(data),
    components: [row1, row2, row3, row4],
  };
}

function buildCharmsClothLevelView(requestId, cloth, mode, data, stepIndex = 0) {
  const buildLevelOptions = (selectedLv) => {
    const options = [];
    for (let lv = 1; lv <= 22; lv += 1) {
      options.push({
        label: charmLevelLabel(lv),
        value: String(lv),
        default: lv === selectedLv,
      });
    }
    return options;
  };
  const selected = cloth.charmKeys.map((ck) => {
    const raw = Number(data?.[ck]);
    return Number.isFinite(raw) ? Math.max(1, Math.min(22, raw)) : null;
  });
  const selects = cloth.charmKeys.map((ck, idx) =>
    new StringSelectMenuBuilder()
      .setCustomId(`optimizecharms:pick:${requestId}:${ck}:${mode}`)
      .setPlaceholder(`${cloth.label} — Charm ${idx + 1}`)
      .addOptions(buildLevelOptions(selected[idx]))
  );
  const primaryBtn =
    mode === "seq"
      ? new ButtonBuilder()
          .setCustomId(`optimizecharms:nextcloth:${requestId}:${cloth.key}`)
          .setLabel("Next Cloth")
          .setStyle(ButtonStyle.Primary)
      : null;
  const setFixedBtn = new ButtonBuilder()
    .setCustomId(`optimizecharms:setfixed:${requestId}:${cloth.key}:${mode}`)
    .setLabel("Set same Lv")
    .setStyle(ButtonStyle.Secondary);
  const secondaryBtn =
    mode === "edit"
      ? new ButtonBuilder()
          .setCustomId(`optimizecharms:back:${requestId}`)
          .setLabel("Back to panel")
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(`optimizecharms:cancel:${requestId}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Danger);

  const selectedSoFarLines = CHARMS_CLOTHS.map((c) => {
    const levels = c.charmKeys.map((ck) => {
      const v = Number(data?.[ck]);
      return Number.isFinite(v) ? charmLevelLabel(Math.max(1, Math.min(22, v))) : null;
    });
    if (!levels.some(Boolean)) return null;
    return `• ${c.label}: ${levels.map((v) => v || "—").join(" / ")}`;
  }).filter(Boolean);
  const selectedSoFar = selectedSoFarLines.length
    ? selectedSoFarLines.join("\n")
    : "• (none selected yet)";

  return {
    content:
      `**Step ${Math.max(1, stepIndex + 1)}/${CHARMS_CLOTHS.length}** — ${cloth.label}\n` +
      "Pick **three levels** from the lists below (Charm 1/2/3).\n\n" +
      `Selected so far:\n${selectedSoFar}`,
    components: [
      new ActionRowBuilder().addComponents(selects[0]),
      new ActionRowBuilder().addComponents(selects[1]),
      new ActionRowBuilder().addComponents(selects[2]),
      primaryBtn
        ? new ActionRowBuilder().addComponents(primaryBtn, setFixedBtn, secondaryBtn)
        : new ActionRowBuilder().addComponents(setFixedBtn, secondaryBtn),
    ],
  };
}

function buildCharmsSetFixedLevelModal(requestId, clothKey, mode, currentData = {}) {
  const cloth = CHARMS_CLOTHS.find((c) => c.key === clothKey);
  const title = cloth ? cloth.label : clothKey;
  const firstCharmKey = cloth?.charmKeys?.[0];
  const current = Number(firstCharmKey ? currentData[firstCharmKey] : null);
  const modal = new ModalBuilder()
    .setCustomId(`optimizecharms:modalsetfixed:${requestId}:${clothKey}:${mode}`)
    .setTitle(`Set same Lv — ${title}`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("level")
        .setLabel("Level (1-22)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(Number.isFinite(current) ? String(Math.max(1, Math.min(22, current))) : "1")
    )
  );
  return modal;
}

function buildCharmsResourcesModal(requestId, defaults = {}) {
  const modal = new ModalBuilder()
    .setCustomId(`optimizecharms:modalresources:${requestId}`)
    .setTitle("Charms Resources");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("charmGuides")
        .setLabel("Charm Guides")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(defaults.charmGuides ?? 0))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("charmDesigns")
        .setLabel("Charm Designs")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(defaults.charmDesigns ?? 0))
    )
  );
  return modal;
}

function buildCharmsLevelsPayloadFromSession(sessionData) {
  const charmLevels = {};
  for (const cloth of CHARMS_CLOTHS) for (const ck of cloth.charmKeys)
    charmLevels[ck] = Math.max(1, Math.min(22, Number(sessionData[ck] ?? 1)));
  return charmLevels;
}

/** @returns {Promise<boolean>} */
async function handleCharmsChatMessage(message) {
  if (!message.guild || !message.content) return false;
  if (!isGovGearAllowedContext(message.guildId, message.channelId)) return false;

  const normalized = normalizeTriggerText(message.content);
  if (!CHARMS_CHAT_TRIGGER_PHRASES.has(normalized)) return false;

  const sessionKey = getGovGearChatSessionKey(message);
  if (govGearChatSessions.has(sessionKey)) {
    govGearChatSessions.delete(sessionKey);
    await message.reply("Ending **Governor Gear** wizard — starting **Charms** panel.");
  }
  clearCharmsPanelSessionsForMessage(message);

  const requestId = `${message.author.id}-${Date.now()}`;
  const defaults = {
    charmGuides: 0,
    charmDesigns: 0,
  };
  const memory = getUserCharmsMemory(message.author.id) || {};
  const initialData = { ...defaults, ...memory };
  charmsPanelSessions.set(requestId, {
    userId: message.author.id,
    channelId: message.channelId,
    data: initialData,
    slotIndex: 0,
    createdAt: Date.now(),
  });
  if (hasCompleteCharmsData(memory)) {
    const review = buildCharmsSavedReviewView(requestId, initialData);
    await message.reply({ content: review.content, components: review.components });
    return true;
  }
  const first = CHARMS_CLOTHS[0];
  const view = buildCharmsClothLevelView(requestId, first, "seq", initialData, 0);
  await message.reply({ content: view.content, components: view.components });
  return true;
}

async function handleGovGearChatMessage(message) {
  if (!message.content) return;
  if (!isGovGearAllowedContext(message.guildId, message.channelId)) return;
  const sessionKey = getGovGearChatSessionKey(message);
  const existing = govGearChatSessions.get(sessionKey);

  if (!existing) {
    const normalized = normalizeTriggerText(message.content);
    if (!GOV_GEAR_CHAT_TRIGGER_PHRASES.has(normalized)) return;
    clearCharmsPanelSessionsForMessage(message);
    const requestId = `${message.author.id}-${Date.now()}`;
    const lastMemory = getUserGovGearMemory(message.author.id) || {};
    govGearModalSessions.set(requestId, { userId: message.author.id, data: { ...lastMemory }, createdAt: Date.now() });
    if (hasCompleteGearData(lastMemory)) {
      const review = buildSavedGearReviewView(requestId, govGearModalSessions.get(requestId).data);
      await message.reply({
        content: review.content,
        components: review.components,
      });
      return;
    }
    const openButton = new ButtonBuilder()
      .setCustomId(`optimizegovgear:startselect:${requestId}`)
      .setLabel("Open Governor Gear Panel")
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(openButton);
    await message.reply({
      content: "Governor Gear — use the button to start **Step 1/6** (Hat) and pick all six slots, then resources.",
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
    activities: [
      {
        name: "/kingshot /kvkmatches /kingdomage /transfers /quote /optimizegovgear /optimizecharms",
        type: ActivityType.Watching,
      },
    ],
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
  try {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== "optimizegovgear") {
      await interaction.respond([]);
      return;
    }
    if (!isGovGearAllowedContext(interaction.guildId, interaction.channelId)) {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    const q = String(focused.value || "").trim().toLowerCase().replace(/\s+/g, "");
    const choices = GOV_GEAR_LEVELS.filter((v) => v.toLowerCase().replace(/\s+/g, "").includes(q))
      .slice(0, 25)
      .map((v) => ({ name: v, value: v }));
    await interaction.respond(choices);
    return;
  }

  const isOptimizeComponent =
    (interaction.isButton() && interaction.customId.startsWith("optimizegovgear:")) ||
    (interaction.isButton() && interaction.customId.startsWith("optimizecharms:")) ||
    (interaction.isStringSelectMenu() && interaction.customId.startsWith("optimizegovgear:")) ||
    (interaction.isStringSelectMenu() && interaction.customId.startsWith("optimizecharms:")) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith("optimizegovgear:")) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith("optimizecharms:"));
  if (isOptimizeComponent && !isGovGearAllowedContext(interaction.guildId, interaction.channelId)) {
    await replyGovGearWrongChannel(interaction);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("quotegameimg:")) {
      const parts = interaction.customId.split(":");
      const correctUserId = parts[1];
      const selectedUserId = parts[2];
      if (areAllQuoteButtonsDisabled(interaction.message)) {
        await interaction.reply({ content: "הסבב הזה כבר נסגר ✋", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!correctUserId || !selectedUserId) {
        await interaction.reply({ content: "אירעה שגיאה במשחק. נסו שוב 🙏" });
        return;
      }
      const clickerName = await resolveDisplayNameInGuild(interaction.guild, interaction.user.id, interaction.user.username);
      const selectedName = await resolveDisplayNameInGuild(
        interaction.guild,
        selectedUserId,
        interaction.component?.label || "משתמש"
      );
      let correctUsername = "לא ידוע";
      try {
        const user = await interaction.client.users.fetch(correctUserId);
        if (user?.username) {
          correctUsername = await resolveDisplayNameInGuild(interaction.guild, correctUserId, user.username);
        }
      } catch (_) {
        // ignore
      }
      const rows = buildDisabledQuoteRows(interaction.message);
      const isCorrect = selectedUserId === correctUserId;
      const resultText = buildPublicQuoteResultMessage({
        clickerName,
        selectedName,
        isCorrect,
        correctName: correctUsername,
      });
      await interaction.update({
        components: rows,
      });
      await interaction.channel.send({
        content: resultText,
        reply: { messageReference: interaction.message.id },
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    if (interaction.customId.startsWith("quotegame:")) {
      const parts = interaction.customId.split(":");
      const correctUserId = parts[1];
      const selectedUserId = parts[2];
      if (areAllQuoteButtonsDisabled(interaction.message)) {
        await interaction.reply({ content: "הסבב הזה כבר נסגר ✋", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!correctUserId || !selectedUserId) {
        await interaction.reply({ content: "אירעה שגיאה במשחק. נסו שוב 🙏" });
        return;
      }
      const clickerName = await resolveDisplayNameInGuild(interaction.guild, interaction.user.id, interaction.user.username);
      const selectedName = await resolveDisplayNameInGuild(
        interaction.guild,
        selectedUserId,
        interaction.component?.label || "משתמש"
      );
      let correctUsername = "לא ידוע";
      try {
        const user = await interaction.client.users.fetch(correctUserId);
        if (user?.username) {
          correctUsername = await resolveDisplayNameInGuild(interaction.guild, correctUserId, user.username);
        }
      } catch (_) {
        // ignore
      }
      const rows = buildDisabledQuoteRows(interaction.message);
      const isCorrect = selectedUserId === correctUserId;
      const resultText = buildPublicQuoteResultMessage({
        clickerName,
        selectedName,
        isCorrect,
        correctName: correctUsername,
      });
      await interaction.update({
        components: rows,
      });
      await interaction.channel.send({
        content: resultText,
        reply: { messageReference: interaction.message.id },
        allowedMentions: { repliedUser: false },
      });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:cloth:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const clothKey = parts[3];
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const cloth = CHARMS_CLOTHS.find((c) => c.key === clothKey);
      if (!cloth) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      const slotIndex = CHARMS_CLOTHS.findIndex((c) => c.key === cloth.key);
      session.slotIndex = slotIndex >= 0 ? slotIndex : 0;
      charmsPanelSessions.set(requestId, session);
      const view = buildCharmsClothLevelView(requestId, cloth, "edit", session.data, session.slotIndex);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:editslot:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= CHARMS_CLOTHS.length) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      session.slotIndex = slotIndex;
      charmsPanelSessions.set(requestId, session);
      const cloth = CHARMS_CLOTHS[slotIndex];
      const view = buildCharmsClothLevelView(requestId, cloth, "edit", session.data, slotIndex);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:nextcloth:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const clothKey = parts[3];
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const idx = CHARMS_CLOTHS.findIndex((c) => c.key === clothKey);
      if (idx < 0) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      const nextIndex = idx + 1;
      if (nextIndex < CHARMS_CLOTHS.length) {
        session.slotIndex = nextIndex;
        charmsPanelSessions.set(requestId, session);
        const nextCloth = CHARMS_CLOTHS[nextIndex];
        const view = buildCharmsClothLevelView(requestId, nextCloth, "seq", session.data, nextIndex);
        await interaction.update({ content: view.content, components: view.components });
        return;
      }
      const review = buildCharmsSavedReviewView(requestId, session.data);
      await interaction.update({ content: review.content, components: review.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:setfixed:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const clothKey = parts[3];
      const mode = parts[4] || "seq";
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(buildCharmsSetFixedLevelModal(requestId, clothKey, mode, session.data));
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:clothback:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const clothKey = parts[3];
      const mode = parts[4] || "seq";
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const cloth = CHARMS_CLOTHS.find((c) => c.key === clothKey);
      if (!cloth) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      const idx = CHARMS_CLOTHS.findIndex((c) => c.key === cloth.key);
      const view = buildCharmsClothLevelView(requestId, cloth, mode, session.data, idx);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:resources:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:resources:");
      if (!requestId) return;
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(buildCharmsResourcesModal(requestId, session.data));
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:back:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:back:");
      if (!requestId) return;
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const panel = buildCharmsSavedReviewView(requestId, session.data);
      await interaction.update({ content: panel.content, components: panel.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:cancel:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:cancel:");
      if (!requestId) return;
      charmsPanelSessions.delete(requestId);
      await interaction.update({ content: "Charms panel cancelled.", components: [] });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:restart:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:restart:");
      if (!requestId) return;
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      const resetData = {
        charmGuides: Number(session.data.charmGuides ?? 0),
        charmDesigns: Number(session.data.charmDesigns ?? 0),
      };
      for (const cloth of CHARMS_CLOTHS) {
        for (const ck of cloth.charmKeys) resetData[ck] = undefined;
      }
      session.data = resetData;
      session.slotIndex = 0;
      charmsPanelSessions.set(requestId, session);
      const first = CHARMS_CLOTHS[0];
      const view = buildCharmsClothLevelView(requestId, first, "seq", session.data, 0);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:submit:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:submit:");
      if (!requestId) return;
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({ content: "This charms panel session expired. Type `charms` again.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await fetchCharmsOptimization({
          charmGuides: Number(session.data.charmGuides ?? 0),
          charmDesigns: Number(session.data.charmDesigns ?? 0),
          charmLevels: buildCharmsLevelsPayloadFromSession(session.data),
        });
        rememberUserCharmsMemory(interaction.user.id, session.data);
        charmsPanelSessions.delete(requestId);
        if (!result.ok) {
          await interaction.editReply(
            `${result.message}\nYou can still optimize manually at <https://kingshotoptimizer.com/charms/optimize>`
          );
          return;
        }
        let content = buildCharmsOptimizerReplyMarkdown(result.data);
        if (content.length > 2000) {
          content = `${content.slice(0, 1990)}…\n_(truncated — open the site for the full list.)_`;
        }
        await interaction.editReply(content);
      } catch (e) {
        charmsPanelSessions.delete(requestId);
        if (isIgnorableInteractionResponseError(e)) throw e;
        console.error("Charms submit failed:", e);
        try {
          await interaction.editReply({
            content: "Unexpected error while contacting the optimizer. Try again or use <https://kingshotoptimizer.com/charms/optimize>.",
          });
        } catch (_) {
          /* interaction may be gone */
        }
      }
      return;
    }

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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
          content: "This panel session expired. Type `gov gear` again.",
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
    if (interaction.customId.startsWith("optimizecharms:pick:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const charmKey = parts[3];
      const mode = parts[4] || "seq";
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This charms panel session expired. Type `charms` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const cloth = CHARMS_CLOTHS.find((c) => c.charmKeys.includes(charmKey));
      if (!cloth) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      const selectedLv = Number(interaction.values[0]);
      session.data[charmKey] = Math.max(1, Math.min(22, Number.isFinite(selectedLv) ? selectedLv : 1));
      charmsPanelSessions.set(requestId, session);

      if (mode === "edit") {
        const slotIndex = CHARMS_CLOTHS.findIndex((c) => c.key === cloth.key);
        const view = buildCharmsClothLevelView(requestId, cloth, "edit", session.data, slotIndex);
        await interaction.update({ content: view.content, components: view.components });
        return;
      }
      const idx = CHARMS_CLOTHS.findIndex((c) => c.key === cloth.key);
      const view = buildCharmsClothLevelView(requestId, cloth, "seq", session.data, idx);
      await interaction.update({ content: view.content, components: view.components });
      return;
    }

    if (interaction.customId.startsWith("optimizegovgear:pick:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const slotIndex = Number(parts[3]);
      const pending = govGearModalSessions.get(requestId);
      if (!pending || pending.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This panel session expired. Type `gov gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
      if (!slot) {
        await interaction.reply({ content: "Invalid panel state. Start again with `gov gear`.", flags: MessageFlags.Ephemeral });
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
        content: `${govGearSlotStepLine(5)} ✓ All gear slots filled.\nClick below for **panel 2/2** (resources).`,
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
          content: "This panel session expired. Type `gov gear` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const slot = GOV_GEAR_SLOT_STEPS[slotIndex];
      if (!slot) {
        await interaction.reply({ content: "Invalid panel state. Start again with `gov gear`.", flags: MessageFlags.Ephemeral });
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
    if (interaction.customId.startsWith("optimizecharms:modalsetfixed:")) {
      const parts = interaction.customId.split(":");
      const requestId = parts[2];
      const clothKey = parts[3];
      const mode = parts[4] || "seq";
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This charms panel session expired. Type `charms` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const cloth = CHARMS_CLOTHS.find((c) => c.key === clothKey);
      if (!cloth) {
        await interaction.reply({ content: "Invalid charms cloth selection.", flags: MessageFlags.Ephemeral });
        return;
      }
      const lv = Number(interaction.fields.getTextInputValue("level"));
      if (!Number.isFinite(lv) || lv < 1 || lv > 22) {
        await interaction.reply({ content: "Level must be a whole number between 1 and 22.", flags: MessageFlags.Ephemeral });
        return;
      }
      const fixed = Math.floor(lv);
      for (const ck of cloth.charmKeys) session.data[ck] = fixed;
      charmsPanelSessions.set(requestId, session);
      const idx = CHARMS_CLOTHS.findIndex((c) => c.key === cloth.key);
      const view = buildCharmsClothLevelView(requestId, cloth, mode, session.data, idx);
      await interaction.reply({
        content: `Applied **${charmLevelLabel(fixed)}** to all charms for **${cloth.label}**.\n\n${view.content}`,
        components: view.components,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.customId.startsWith("optimizecharms:modalresources:")) {
      const requestId = parseRequestIdFromCustomId(interaction.customId, "optimizecharms:modalresources:");
      if (!requestId) return;
      const session = charmsPanelSessions.get(requestId);
      if (!session || session.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This charms panel session expired. Type `charms` again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const guides = Number(interaction.fields.getTextInputValue("charmGuides"));
      const designs = Number(interaction.fields.getTextInputValue("charmDesigns"));
      if (!Number.isFinite(guides) || guides < 0 || !Number.isFinite(designs) || designs < 0) {
        await interaction.reply({
          content: "Resources must be non-negative whole numbers.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      session.data.charmGuides = Math.floor(guides);
      session.data.charmDesigns = Math.floor(designs);
      charmsPanelSessions.set(requestId, session);
      rememberUserCharmsMemory(interaction.user.id, session.data);
      const review = buildCharmsSavedReviewView(requestId, session.data);
      await interaction.reply({
        content: `Resources saved.\n\n${review.content}`,
        components: review.components,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

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
  if (
    !["kingshot", "kvkmatches", "kingdomage", "transfers", "quote", "optimizegovgear", "optimizecharms"].includes(
      interaction.commandName
    )
  )
    return;

  if (interaction.commandName === "quote") {
    await handleQuoteCommand(interaction);
    return;
  }

  const isEphemeralOptimizerSlash =
    interaction.commandName === "optimizegovgear" || interaction.commandName === "optimizecharms";
  if (isEphemeralOptimizerSlash && !isGovGearAllowedContext(interaction.guildId, interaction.channelId)) {
    await interaction.reply({
      content: `Optimizer commands are only available in ${formatGovGearAllowedTargetMention()}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  /** Public defer for Kingshot lookups (embeds + brand file); ephemeral for optimizer slash commands. */
  await interaction.deferReply(isEphemeralOptimizerSlash ? { flags: MessageFlags.Ephemeral } : {});

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
    if (interaction.commandName === "transfers") {
      await handleTransfers(interaction);
      return;
    }
    if (interaction.commandName === "optimizecharms") {
      await handleOptimizeCharms(interaction);
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
  } catch (e) {
    if (isIgnorableInteractionResponseError(e)) {
      console.warn("Ignored interaction response error (expired token or duplicate ack).");
      return;
    }
    console.error("Interaction handler error:", e);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Unexpected error while processing the interaction.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* ignore */
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  try {
    if (await startImageQuoteGameInMessage(message)) return;
    if (await startQuoteGameInMessage(message)) return;
    if (message.guild && enableNicknameChannel && message.channelId === nicknameChannelId) {
      await handleNicknameChannelMessage(message);
      return;
    }
    if (await handlePublicApiShortcuts(message)) return;
    if (await handleCharmsChatMessage(message)) return;
    await handleGovGearChatMessage(message);
  } catch (e) {
    console.error("Message handler error:", e);
    try {
      await message.reply("Unexpected error while processing your message.");
    } catch (_) {
      /* ignore */
    }
  }
});

client.login(token);
