/**
 * Run once after setting DISCORD_TOKEN, DISCORD_CLIENT_ID, and optionally GUILD_ID in .env
 *   npm run register-commands
 * The main bot also registers commands on startup; this script is optional for manual refresh.
 */
require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

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
        .setDescription("Governor profile screenshot (gear matched vs your Kingshot-image reference set)")
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
        .setDescription("Attach a debug image of the 6 slot crops (detected vs full-frame bounds)")
    )
    .toJSON(),
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`Registered guild commands for guild ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Registered global commands (may take up to ~1 hour to show).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
