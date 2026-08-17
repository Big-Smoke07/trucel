# Single-server reaction vote bot

Reply to a server message and mention the bot in that reply to open a vote on
the original message (for example, a GIF). The bot adds these two custom
reactions and begins a timed voting window. Mentioning it without replying
opens voting on the mention message itself:

- Upvote: `1538668842882961488`
- Downvote: `1538665541097488506`

The author of the voted-on message receives the points. A member can have one
vote per message and may switch it until the voting window ends. Vote changes
are recorded immediately, so `?leaderboard` always uses the latest totals.

## Setup

1. Create a Discord application and bot at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, enable **Message Content Intent**.
3. Invite the bot to your server with these permissions:
   - View Channels
   - Read Message History
   - Send Messages
   - Add Reactions
   - Manage Messages (needed to remove the previous reaction when someone changes their vote)
4. Copy `.env.example` to `.env`, then add your bot token and server ID. Set
   `VOTE_WINDOW_MINUTES` if 15 minutes is not right for you.
5. Run:

   ```powershell
   npm install
   npm start
   ```

The `data/votes.json` file is created automatically and keeps the leaderboard
between restarts. Do not commit or share `.env`.

## Keep-alive and streaming status

The bot serves `http://your-host:3000/health`, returning a small JSON health
response. If your hosting provider sleeps inactive apps, configure its monitor
or an uptime-monitor service to request that URL regularly. Set `PORT` in
`.env` if your host supplies a different port.

Its Discord status is set to **Streaming: live votes**, linked to the supplied
YouTube URL.

## Commands

- Mention the bot in a message: opens voting on that message.
- `?leaderboard`: shows the top ten members by received upvotes and downvotes.
