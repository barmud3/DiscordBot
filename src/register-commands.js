require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const { CHARM_LEVEL_API_KEYS } = require("./kingshot-api");

function charmSlashOptionDescription(apiKey) {
  const m = String(apiKey).match(/^(cavalry|infantry|archery)_gear_(\d)_charm_(\d)$/);
  if (!m) return String(apiKey).slice(0, 100);
  const troop = m[1][0].toUpperCase() + m[1].slice(1);
  const desc = `${troop} gear ${m[2]} — charm ${m[3]} (0–22)`;
  return desc.length > 100 ? `${desc.slice(0, 97)}...` : desc;
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
for (const key of CHARM_LEVEL_API_KEYS) {
  optimizeCharmsSlash.addIntegerOption((o) =>
    o
      .setName(key)
      .setDescription(charmSlashOptionDescription(key))
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
    .setName("transfers")
    .setDescription("Show past and upcoming kingdom transfer windows")
    .addIntegerOption((o) =>
      o
        .setName("kingdom_id")
        .setDescription("Optional kingdom ID for last-leading transfer hint")
        .setRequired(false)
        .setMinValue(1)
    )
    .toJSON(),
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
    )
    .toJSON(),
  optimizeCharmsSlash.toJSON(),
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
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
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
