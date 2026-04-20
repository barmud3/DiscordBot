require("dotenv").config();
const {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
} = require("discord.js");
const { fetchPlayerInfo, fetchKvkMatches, fetchKvkMatchesForKingdom } = require("./kingshot-api");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID || "";
const allowedChannelId = process.env.ALLOWED_CHANNEL_ID || "";
const enableSimpleMessages =
  String(process.env.ENABLE_SIMPLE_MESSAGES).toLowerCase() === "true";

if (!token || !clientId) {
  console.error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID in .env (see .env.example).");
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
];

function channelAllowed(channelId) {
  if (!allowedChannelId) return true;
  return channelId === allowedChannelId;
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

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {string} rawId
 */
async function replyWithPlayerLookup(interaction, rawId) {
  const trimmed = String(rawId).trim();
  if (!/^\d+$/.test(trimmed)) {
    const msg = "Player ID must be numbers only (example: `8767319`).";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true });
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    ...(enableSimpleMessages
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
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!["kingshot", "kvkmatches"].includes(interaction.commandName)) return;

  if (!channelAllowed(interaction.channelId)) {
    await interaction.reply({
      content: "Player lookup is only allowed in the designated channel.",
      ephemeral: true,
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
          ephemeral: true,
        });
      }
    } catch (_) {
      /* ignore */
    }
  }
});

if (enableSimpleMessages) {
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!channelAllowed(message.channelId)) return;

    const content = message.content.trim();
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
