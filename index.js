import 'dotenv/config';
import { createServer } from 'node:http';
import {
  ActivityType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const required = ['DISCORD_TOKEN', 'GUILD_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}

const voteWindowMinutes = Number(process.env.VOTE_WINDOW_MINUTES ?? 15);
if (!Number.isFinite(voteWindowMinutes) || voteWindowMinutes <= 0) {
  throw new Error('VOTE_WINDOW_MINUTES must be a positive number.');
}

const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  windowMs: voteWindowMinutes * 60_000,
  port: Number(process.env.PORT ?? 3000),
  streamUrl: 'https://www.youtube.com/watch?v=AJmaVPfyudQ',
  emojis: {
    up: '1538668842882961488',
    down: '1538665541097488506',
  },
};

const filename = fileURLToPath(import.meta.url);
const dataFile = path.join(path.dirname(filename), '..', 'data', 'votes.json');
let state = { messages: {}, members: {} };
let queue = Promise.resolve();

function runSerially(work) {
  queue = queue.then(work).catch((error) => console.error('Vote processing error:', error));
  return queue;
}

async function loadState() {
  try {
    state = JSON.parse(await readFile(dataFile, 'utf8'));
    state.messages ??= {};
    state.members ??= {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveState();
  }
}

async function saveState() {
  await mkdir(path.dirname(dataFile), { recursive: true });
  await writeFile(dataFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function isVoteEmoji(reaction) {
  if (reaction.emoji.id === config.emojis.up) return 'up';
  if (reaction.emoji.id === config.emojis.down) return 'down';
  return null;
}

function ensureMember(memberId) {
  state.members[memberId] ??= { up: 0, down: 0 };
  return state.members[memberId];
}

function changeScore(authorId, oldVote, newVote) {
  const totals = ensureMember(authorId);
  if (oldVote) totals[oldVote] = Math.max(0, totals[oldVote] - 1);
  if (newVote) totals[newVote] += 1;
}

async function resolveEmoji(guild, id) {
  const emoji = await guild.emojis.fetch(id);
  if (!emoji) throw new Error(`Emoji ${id} is not available in this server.`);
  return emoji;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once('ready', () => {
  client.user.setPresence({
    activities: [{
      name: 'Molesting Aahrif',
      type: ActivityType.Streaming,
      url: config.streamUrl,
    }],
    status: 'online',
  });
  console.log(`Logged in as ${client.user.tag}. Voting is restricted to guild ${config.guildId}.`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.guildId !== config.guildId) return;

  const command = message.content.trim().toLowerCase();
  if (command === '!leaderboard') {
    const members = Object.entries(state.members).filter(([, totals]) => totals.up || totals.down);
    const rank = (direction, icon) => {
      const entries = members
        .filter(([, totals]) => totals[direction] > 0)
        .sort(([, a], [, b]) => b[direction] - a[direction])
        .slice(0, 10);
      return entries.length
        ? entries.map(([id, totals], index) => `${index + 1}. <@${id}> — ${icon} ${totals[direction]}`).join('\n')
        : 'No votes yet.';
    };
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Leaderboard')
        .addFields(
          { name: 'Most upvotes received', value: rank('up', '⬆️'), inline: true },
          { name: 'Most downvotes received', value: rank('down', '⬇️'), inline: true },
        )],
    });
    return;
  }

  const manualVoteMatch = message.content.trim().match(/^!(addupvotes|adddownvotes)\s+<@!?(\d+)>$/i);
  if (manualVoteMatch) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply('You need the **Manage Server** permission to adjust vote totals.');
      return;
    }
    const [, action, memberId] = manualVoteMatch;
    const direction = action.toLowerCase() === 'addupvotes' ? 'up' : 'down';
    await runSerially(async () => {
      ensureMember(memberId)[direction] += 1;
      await saveState();
    });
    await message.reply(`Added **1 ${direction}vote** for <@${memberId}>.`);
    return;
  }

  const statsMatch = message.content.trim().match(/^!stats\s+<@!?(\d+)>$/i);
  if (statsMatch) {
    const memberId = statsMatch[1];
    const totals = state.members[memberId] ?? { up: 0, down: 0 };
    const user = await client.users.fetch(memberId).catch(() => null);
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`Stats for ${user?.username ?? `<@${memberId}>`}`)
        .setThumbnail(user?.displayAvatarURL({ size: 256 }) ?? null)
        .addFields(
          { name: 'Upvotes received', value: String(totals.up), inline: true },
          { name: 'Downvotes received', value: String(totals.down), inline: true },
        )],
    });
    return;
  }

  if (!message.mentions.has(client.user)) return;
  await runSerially(async () => {
    // When the mention is sent as a reply (as in Discord's reply UI), vote on
    // the referenced message—for example, the GIF—not on the short ping.
    let target = message;
    if (message.reference?.messageId) {
      const referenced = await message.fetchReference().catch(() => null);
      if (referenced?.guildId === config.guildId) target = referenced;
    }

    if (state.messages[target.id]) return;
    const [upEmoji, downEmoji] = await Promise.all([
      resolveEmoji(target.guild, config.emojis.up),
      resolveEmoji(target.guild, config.emojis.down),
    ]);
    await target.react(upEmoji);
    await target.react(downEmoji);
    state.messages[target.id] = {
      channelId: target.channelId,
      authorId: target.author.id,
      closesAt: Date.now() + config.windowMs,
      votes: {},
    };
    await saveState();
  });
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch();
  if (reaction.message.guildId !== config.guildId) return;
  const vote = isVoteEmoji(reaction);
  if (!vote) return;

  await runSerially(async () => {
    const record = state.messages[reaction.message.id];
    if (!record) return; // Only bot-opened votes are valid.
    if (Date.now() > record.closesAt) {
      await reaction.users.remove(user.id).catch(() => undefined);
      return;
    }
    const previous = record.votes[user.id];
    if (previous === vote) return;

    if (previous) {
      const otherEmojiId = config.emojis[previous];
      const otherReaction = reaction.message.reactions.cache.find((item) => item.emoji.id === otherEmojiId);
      await otherReaction?.users.remove(user.id).catch(() => undefined);
    }
    record.votes[user.id] = vote;
    changeScore(record.authorId, previous, vote);
    await saveState();
  });
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => undefined);
  const message = reaction.message;
  if (message.guildId !== config.guildId) return;
  const vote = isVoteEmoji(reaction);
  if (!vote) return;

  await runSerially(async () => {
    const record = state.messages[message.id];
    if (!record || Date.now() > record.closesAt || record.votes[user.id] !== vote) return;
    delete record.votes[user.id];
    changeScore(record.authorId, vote, null);
    await saveState();
  });
});

await loadState();
createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', discord: client.isReady() ? 'connected' : 'connecting' }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
}).listen(config.port, () => console.log(`Keep-alive endpoint listening on port ${config.port}.`));
await client.login(config.token);
