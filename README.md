# Kingshot Discord bot

Looks up **player name**, **profile image**, **kingdom**, and **level** (with level banner image) using the public API at [kingshot.net](https://kingshot.net/api-docs). The API allows **6 requests per minute**; the bot queues locally to respect that.

## Prerequisites

- [Node.js 18+](https://nodejs.org/) installed
- Python 3.9+ (for PaddleOCR engine)
- A Discord account that can manage your server

---

## Part 1 — Create the bot in Discord (Developer Portal)

1. Open **[Discord Developer Portal](https://discord.com/developers/applications)** and click **New Application**.
2. Name it (e.g. `Kingshot Lookup`) and create it.
3. Under **Bot** (left sidebar):
   - Click **Add Bot** if needed.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** if you use `ENABLE_SIMPLE_MESSAGES=true` and/or `NICKNAME_CHANNEL_ID` (see env). For slash commands only, leave it off.
   - Click **Reset Token**, copy the token, and keep it private (this is `DISCORD_TOKEN`).
4. Under **OAuth2 → General**, copy **Application ID** (this is `DISCORD_CLIENT_ID`).

### Invite the bot to your server

1. Go to **OAuth2 → URL Generator**.
2. Scopes: check **`bot`** and **`applications.commands`**.
3. Bot permissions: at minimum **`Send Messages`**, **`Embed Links`**, **`Use Slash Commands`**, **`Attach Files`** (optional; embeds use URLs). If you use **nickname from channel** (`NICKNAME_CHANNEL_ID`), also grant **`Manage Nicknames`** (and **`Manage Messages`** in that channel if you set `NICKNAME_DELETE_MESSAGE=true`). Example permission integer: `277025508352` covers send messages, embed links, slash commands, read history if needed.
4. Copy the generated URL, open it in a browser, pick your community server, and authorize.

### Get IDs (optional but useful)

Enable **Developer Mode** in Discord: **User Settings → App Settings → Advanced → Developer Mode**.

- **Server (guild) ID:** right-click your server name → **Copy Server ID** → use as `GUILD_ID` for fast slash-command updates.
- **Channel ID:** right-click the channel → **Copy Channel ID** → use as `ALLOWED_CHANNEL_ID` to restrict lookups to one channel.

---

## Part 2 — Configure this project

1. In the project folder, create a file named `.env`.

2. Edit `.env` and set at least the required keys below:

   - `DISCORD_TOKEN` — bot token from the portal  
   - `DISCORD_CLIENT_ID` — Application ID  
   - `GUILD_ID` — your server ID (recommended so `/kingshot` appears within minutes)  
   - `ALLOWED_CHANNEL_ID` — leave empty to allow all channels, or set to lock lookups to one channel  
   - `BRAND_IMAGE_URL` — optional image URL used as thumbnail on KvK/Kingdom embeds  
   - `ENABLE_SIMPLE_MESSAGES` — `true` to also reply when someone sends a message that is **only digits** (1–4 = KvK, 5+ = player ID) and Hebrew **פז"מ** lines. Requires **Message Content Intent**.
   - `NICKNAME_CHANNEL_ID` — set to a channel ID where posting **only** a kingdom number (`1`–`4` digits) sets the member's server nickname to **display name + `#` + number** (max 32 characters). Works **without** `ENABLE_SIMPLE_MESSAGES`. Requires **Message Content Intent** and bot permission **Manage Nicknames**; bot role must be **above** members it should rename.
   - `NICKNAME_COOLDOWN_SECONDS` — optional delay between nickname changes per user (default `60`; `0` = no cooldown).
   - `NICKNAME_DELETE_MESSAGE` — `true` to delete the triggering message after success (needs **Manage Messages** in that channel).
   - `OCR_ENGINE` — OCR backend for image text extraction. Use `paddle` (default) or `tesseract`.
   - `OCR_PYTHON_BIN` — optional Python executable for Paddle bridge (default `python`).

3. Install dependencies and start:

   ```bash
   npm install
   pip install -r requirements-ocr.txt
   npm start
   ```

Keep this process running while the bot should be online (close the terminal = bot goes offline unless you host it elsewhere).

---

## Part 3 — Use in your community

- Slash command: **`/kingshot player_id:`** then enter the numeric in-game ID (e.g. `8767319`).
- Slash command: **`/kvkmatches kingdom_id:`** to fetch all available KvK records for one kingdom (both sides).
- Slash command: **`/kingdomage kingdom_id:`** to show kingdom age and open time.
- Slash command: **`/govgearopt`** with one screenshot (`gear_image`) + required manual resource values (`satin`, `gilded_threads`, `artisans_vision`). The bot OCRs gear tiers and runs Governor Gear optimization through Kingshot Optimizer API. You can override each gear slot with either numeric step or label (e.g. `Red T2 0*`, `Blue 1*`) via `*_label` options.
- If `ENABLE_SIMPLE_MESSAGES=true`, posting only the ID (digits) in the allowed channel also triggers KvK / player lookup (and פז"מ lines for kingdom age).
- If `NICKNAME_CHANNEL_ID` is set, posting only a **1–4 digit** kingdom number **in that channel** updates your **server nickname** to `YourDisplayName #<number>` (truncated to fit Discord's 32-character limit). Reactions ✅ on success unless `NICKNAME_DELETE_MESSAGE=true`.

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

- [https://kingshot.net/api-docs](https://kingshot.net/api-docs) — `GET /api/player-info?playerId=`, `GET /api/kvk/matches`

This project is not affiliated with Discord or Kingshot; use in line with their terms.
