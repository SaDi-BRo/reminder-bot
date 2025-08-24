/**
 * Telegram Reminder Bot (grammY JS)
 * ---------------------------------
 * Single-file bot using long polling + a tiny JSON file DB.
 *
 * Quick setup:
 * 1) npm init -y
 * 2) npm i grammy dotenv
 * 3) Create .env with: BOT_TOKEN=123456:ABC-Your-Telegram-Bot-Token
 * 4) node index.js
 *
 * Optional package.json snippet:
 * {
 *   "name": "grammy-reminder-bot",
 *   "version": "1.0.0",
 *   "main": "index.js",
 *   "type": "commonjs",
 *   "scripts": { "start": "node index.js" },
 *   "dependencies": { "dotenv": "^16.4.5", "grammy": "^1.28.1" }
 * }
 */

const { Bot } = require('grammy');
const express = require('express');
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// --- Config
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Missing BOT_TOKEN in .env');
  process.exit(1);
}
const DB_FILE = path.resolve(__dirname, 'reminders.json');

// --- Tiny JSON DB helpers
function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { lastId: 0, reminders: [] };
  }
}
function writeDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- Parsing helpers
function parseInSyntax(input) {
  // in 10m Buy milk | in 2h Call mom | in 3d Finish report
  const m = input.match(/^in\s+(\d+)\s*([smhd])?\s+(.+)$/i);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase(); // default minutes
  const text = m[3].trim();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = amount * (multipliers[unit] || 60_000);
  const dueAt = Date.now() + ms;
  return { dueAt, text, how: `in ${amount}${unit}` };
}

function parseAtSyntax(input) {
  // at 2025-08-22 15:30 Buy milk
  const m = input.match(
    /^at\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/i
  );
  if (!m) return null;
  const [_, dateStr, hh, mm, textRaw] = m;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const hour = Number(hh);
  const min = Number(mm);
  const text = textRaw.trim();
  const due = new Date(y, mo - 1, d, hour, min, 0, 0); // local time
  return { dueAt: due.getTime(), text, how: `at ${dateStr} ${hh}:${mm}` };
}

function parseTomorrowSyntax(input) {
  // tomorrow 09:00 Standup meeting
  const m = input.match(/^tomorrow\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (!m) return null;
  const [_, hh, mm, textRaw] = m;
  const now = new Date();
  const due = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    Number(hh),
    Number(mm),
    0,
    0
  );
  const text = textRaw.trim();
  return { dueAt: due.getTime(), text, how: `tomorrow ${hh}:${mm}` };
}

function parseWhenAndText(input) {
  return (
    parseInSyntax(input) || parseAtSyntax(input) || parseTomorrowSyntax(input)
  );
}

// --- Bot
const app = express();
const bot = new Bot(TOKEN);

// Middleware for Express to parse JSON
app.use(express.json());

bot.api.setMyCommands([
  { command: 'start', description: 'Start the bot' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'remind', description: 'Create a reminder' },
  { command: 'list', description: 'List your pending reminders' },
  { command: 'delete', description: 'Delete a reminder by id' },
]);

bot.command('start', async ctx => {
  await ctx.reply(
    "👋 Hi! I'm your reminder bot.\n\n" +
      'Create reminders using one of these formats:\n' +
      '• /remind in 10m Buy milk\n' +
      '• /remind in 2h Call mom\n' +
      '• /remind at 2025-08-22 15:30 Team sync\n' +
      '• /remind tomorrow 09:00 Standup\n\n' +
      'Other commands:\n' +
      '• /list – see pending reminders\n' +
      '• /delete <id> – remove a reminder'
  );
});

bot.command('help', async ctx =>
  ctx.api.sendMessage(
    ctx.chat.id,
    `📌 Usage:\n\n` +
      `/remind in <N>[s|m|h|d] <text>\n` +
      `/remind at YYYY-MM-DD HH:MM <text>\n` +
      `/remind tomorrow HH:MM <text>\n\n` +
      `Examples:\n` +
      `• /remind in 45m Take a break\n` +
      `• /remind at 2025-12-31 23:59 Celebrate!\n` +
      `• /remind tomorrow 08:00 Gym\n`
  )
);

bot.command('remind', async ctx => {
  const arg = (ctx.match || '').trim();
  if (!arg) {
    return ctx.reply(
      '❓ Please provide details.\n' +
        'Try: /remind in 15m Drink water\n' +
        'or:  /remind at 2025-08-22 15:30 Team sync\n' +
        'or:  /remind tomorrow 09:00 Standup'
    );
  }

  const parsed = parseWhenAndText(arg);
  if (!parsed) {
    return ctx.reply(
      "⚠️ Couldn't parse that. Supported:\n" +
        '• in <N>[s|m|h|d] <text>\n' +
        '• at YYYY-MM-DD HH:MM <text>\n' +
        '• tomorrow HH:MM <text>'
    );
  }

  if (!parsed.text) return ctx.reply('⚠️ Missing reminder text.');
  if (parsed.dueAt <= Date.now())
    return ctx.reply('⏱️ That time is in the past.');

  const db = readDB();
  const id = ++db.lastId;
  const reminder = {
    id,
    chatId: ctx.chat.id,
    userId: ctx.from?.id,
    text: parsed.text,
    dueAt: parsed.dueAt,
    createdAt: Date.now(),
    status: 'pending',
    how: parsed.how,
  };
  db.reminders.push(reminder);
  writeDB(db);

  const due = new Date(parsed.dueAt);
  await ctx.reply(
    `✅ Reminder #${id} set for ${due.toLocaleString()}\n` + `• ${parsed.text}`
  );
});

bot.command('list', async ctx => {
  const db = readDB();
  const items = db.reminders
    .filter(r => r.chatId === ctx.chat.id && r.status === 'pending')
    .sort((a, b) => a.dueAt - b.dueAt);

  if (!items.length) return ctx.reply('ℹ️ No pending reminders.');

  const lines = items.map(r => {
    const due = new Date(r.dueAt).toLocaleString();
    return `#${r.id} • ${due} — ${r.text}`;
  });
  await ctx.reply('📝 Pending reminders:\n' + lines.join('\n'));
});

bot.command('delete', async ctx => {
  const arg = (ctx.match || '').trim();
  const id = Number(arg);
  if (!id) return ctx.reply('⚠️ Usage: /delete <id>');

  const db = readDB();
  const r = db.reminders.find(x => x.id === id && x.chatId === ctx.chat.id);
  if (!r) return ctx.reply('❌ Not found.');
  r.status = 'deleted';
  r.deletedAt = Date.now();
  writeDB(db);
  await ctx.reply(`🗑️ Deleted reminder #${id}.`);
});

// --- Scheduler: checks every 15s for due reminders and sends them
async function tick(bot) {
  const now = Date.now();
  const db = readDB();
  const due = db.reminders.filter(
    r => r.status === 'pending' && r.dueAt <= now
  );
  for (const r of due) {
    try {
      await bot.api.sendMessage(
        r.chatId,
        `⏰ Reminder${
          r.userId ? ` for <a href=\"tg://user?id=${r.userId}\">you</a>` : ''
        }: ${r.text}`,
        { parse_mode: 'HTML' }
      );
      r.status = 'sent';
      r.sentAt = Date.now();
    } catch (err) {
      console.error('Failed to send reminder #' + r.id, err);
      // Keep it pending; we'll retry next tick.
    }
  }
  if (due.length) writeDB(db);
}

setInterval(() => tick(bot), 15_000);

bot.init();

// Choose between Webhook or Polling
if (process.env.USE_WEBHOOK === 'true') {
  // Webhook mode
  app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  app.listen(process.env.PORT, async () => {
    console.log(`Server running on port ${process.env.PORT}`);
    await bot.api.setWebhook(process.env.WEBHOOK_URL);
  });
} else {
  // Polling mode
  bot.start({
    onStart: info => console.log(`🤖 @${info.username} is running…`),
  });
}
