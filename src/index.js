require("dotenv").config();
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
} = require("discord.js");
const {
  fetchPlayerInfo,
  fetchKvkMatchesForKingdom,
  fetchKingdomTrackerById,
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  presence: {
    status: "online",
    activities: [{ name: "/kingshot /kvkmatches /kingdomage", type: ActivityType.Watching }],
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
  if (!interaction.isChatInputCommand()) return;
  if (!["kingshot", "kvkmatches", "kingdomage"].includes(interaction.commandName)) return;

  await interaction.deferReply();

  try {
    if (interaction.commandName === "kingshot") {
      await handleKingshot(interaction);
      return;
    }
    if (interaction.commandName === "kvkmatches") {
      await handleKvkMatches(interaction);
      return;
    }
    await handleKingdomAge(interaction);
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

client.login(token);
