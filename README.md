# Kingshot Discord bot

Looks up **player name**, **profile image**, **kingdom**, and **level** (with level banner image) using the public API at [kingshot.net](https://kingshot.net/api-docs). The API allows **6 requests per minute**; the bot queues locally to respect that.

## Prerequisites

- [Node.js 18+](https://nodejs.org/) installed
- A Discord account that can manage your server

---

## Part 1 — Create the bot in Discord (Developer Portal)

1. Open **[Discord Developer Portal](https://discord.com/developers/applications)** and click **New Application**.
2. Name it (e.g. `Kingshot Lookup`) and create it.
3. Under **Bot** (left sidebar):
   - Click **Add Bot** if needed.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** only if you plan to use `ENABLE_SIMPLE_MESSAGES=true` (see env). For slash commands only, leave it off.
   - Click **Reset Token**, copy the token, and keep it private (this is `DISCORD_TOKEN`).
4. Under **OAuth2 → General**, copy **Application ID** (this is `DISCORD_CLIENT_ID`).

### Invite the bot to your server

1. Go to **OAuth2 → URL Generator**.
2. Scopes: check **`bot`** and **`applications.commands`**.
3. Bot permissions: at minimum **`Send Messages`**, **`Embed Links`**, **`Use Slash Commands`**, **`Attach Files`** (optional; embeds use URLs). Example permission integer: `277025508352` covers send messages, embed links, slash commands, read history if needed.
4. Copy the generated URL, open it in a browser, pick your community server, and authorize.

### Get IDs (optional but useful)

Enable **Developer Mode** in Discord: **User Settings → App Settings → Advanced → Developer Mode**.

- **Server (guild) ID:** right-click your server name → **Copy Server ID** → use as `GUILD_ID` for fast slash-command updates.
- **Channel ID:** right-click the channel → **Copy Channel ID** → use as `ALLOWED_CHANNEL_ID` to restrict lookups to one channel.

---

## Part 2 — Configure this project

1. In the project folder, copy `.env.example` to `.env`:

   ```bash
   copy .env.example .env
   ```

   On macOS/Linux: `cp .env.example .env`

2. Edit `.env`:

   - `DISCORD_TOKEN` — bot token from the portal  
   - `DISCORD_CLIENT_ID` — Application ID  
   - `GUILD_ID` — your server ID (recommended so `/kingshot` appears within minutes)  
   - `ALLOWED_CHANNEL_ID` — leave empty to allow all channels, or set to lock lookups to one channel  
   - `ENABLE_SIMPLE_MESSAGES` — `true` to also reply when someone sends a message that is **only digits** (player ID). Requires **Message Content Intent** on the bot.

3. Install dependencies and start:

   ```bash
   npm install
   npm start
   ```

Keep this process running while the bot should be online (close the terminal = bot goes offline unless you host it elsewhere).

---

## Part 3 — Use in your community

- Slash command: **`/kingshot player_id:`** then enter the numeric in-game ID (e.g. `8767319`).
- If `ENABLE_SIMPLE_MESSAGES=true`, posting only the ID (digits) in the allowed channel also triggers a lookup.

Tell members: **only share IDs in public channels if they are comfortable**; IDs can be used to look up public profile data via the API.

---

## Hosting (stay online 24/7)

Your PC must run `npm start` continuously, or use a host such as:

- A small **VPS** (systemd service or PM2)
- **Railway**, **Render**, **Fly.io**, etc. (set the same env vars in the dashboard, start command `npm start`)

Use Node 18+ on the host. Do **not** commit `.env` to git.

---

## Troubleshooting

| Issue | What to try |
|--------|-------------|
| `/kingshot` does not appear | Set `GUILD_ID` and restart; or wait up to ~1 hour for global registration. Run `npm run register-commands` after fixing `.env`. |
| “Missing Access” or slash errors | Re-invite the bot with `applications.commands` scope; ensure bot role can use slash commands in that channel. |
| Rate limit messages | Kingshot API is 6/min; wait and retry. |
| Simple messages not working | Turn on **Message Content Intent** for the bot; set `ENABLE_SIMPLE_MESSAGES=true`. |

---

## API reference

- [https://kingshot.net/api-docs](https://kingshot.net/api-docs) — `GET /api/player-info?playerId=`

This project is not affiliated with Discord or Kingshot; use in line with their terms.
