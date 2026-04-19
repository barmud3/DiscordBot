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
const { fetchPlayerInfo } = require("./kingshot-api");

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
  if (interaction.commandName !== "kingshot") return;

  if (!channelAllowed(interaction.channelId)) {
    await interaction.reply({
      content: "Player lookup is only allowed in the designated channel.",
      ephemeral: true,
    });
    return;
  }

  const playerId = interaction.options.getString("player_id", true);
  try {
    await replyWithPlayerLookup(interaction, playerId);
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
    if (!/^\d{4,20}$/.test(content)) return;

    const result = await fetchPlayerInfo(content);
    if (!result.ok) {
      await message.reply({ content: result.message });
      return;
    }

    await message.reply({ embeds: [buildPlayerEmbed(result.data, content)] });
  });
}

client.login(token).catch((e) => {
  console.error("Login failed:", e);
  process.exit(1);
});
