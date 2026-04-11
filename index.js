const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const { spawn } = require('child_process');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials
} = require('discord.js');
const { createVoiceManager } = require('./voice');
const {
  DEFAULT_BASE_DIR,
  ensureDataDirs,
  readJsonFile,
  readServerData,
  readUserData,
  updateUserData
} = require('./dataManager');
const prism = require('prism-media');
const envPath = path.join(__dirname, '.env');
require('dotenv').config({ path: envPath });

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const coupleUserIds = new Set(['1084265104767455242', '850976200562311168', '735212643865854104']);
const AUTHORIZED_USER_ID = '735212643865854104';
const whitelistFile = path.join(__dirname, 'whitelist.json');
const commandsFile = path.join(__dirname, 'commands.json');
const ignoredBotIds = ['1448458688074481734'];
const parseEnvList = (value) =>
  new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
const allowedChannels = parseEnvList(process.env.ALLOWED_CHANNELS);
const allowedGuilds = parseEnvList(process.env.ALLOWED_GUILDS);
const allowedUsers = parseEnvList(process.env.ALLOWED_USERS);

const mentionsFile = path.join(__dirname, 'mentions.json');
const statsFile = path.join(__dirname, 'stats.json');
const responsesFile = path.join(__dirname, 'responses.json');
const remindFile = path.join(__dirname, 'remind.json');
const remindQueueFile = path.join(__dirname, 'remindQueue.json');
const timePrefsFile = path.join(__dirname, 'timezones.json');
const timezoneAliasesFile = path.join(__dirname, 'timezoneAliases.json');
const timezoneAliases = JSON5.parse(fs.readFileSync(timezoneAliasesFile, 'utf8'));
const commandsConfig = JSON5.parse(fs.readFileSync(commandsFile, 'utf8'));
const commandIds = Object.keys(commandsConfig || {});
const commandDef = (id) => (commandsConfig?.[id] ? { id, ...commandsConfig[id] } : null);
const KEYWORD_ALERT_GUILD_ID = '1123708960319475803';
const KEYWORD_ALERT_CHANNEL_ID = '1130281580800262226';
const KEYWORD_ALERT_USER_ID = '735212643865854104';
const KEYWORD_ALERT_DM_CHANNEL_ID = '1448530417799008438';
const KEYWORD_ALERT_TERMS = ['boargalos', 'boardrick', 'boarfadius', 'boarnderwear', 'santa'];
const TIMEOUT_ROLE_ID = '1458107506013376646';
const TWITTER_SITE_BLOCK_CLI = 'C:\\Users\\Bread\\Documents\\site block\\cli\\cli.py';
const TWITTER_SITE_BLOCK_DOMAINS = ['abs.twimg.com', 'pbs.twimg.com', 'x.com', 'api.x.com', 'twitter.com', 'video.twimg.com'];
const SELF_TOGGLE_ROLE_CONFIG = {
  cam: { roleId: '1455337254804263117' },
  mic: { roleId: '1479857771993366741' }
};
const triggerMap = commandIds.reduce((acc, id) => {
  const trigger = String(commandDef(id)?.trigger || '').toLowerCase();
  if (trigger) acc[trigger] = id;
  return acc;
}, {});
const triggerFor = (id) => commandDef(id)?.trigger || '';
const getCommandId = (token) => triggerMap[String(token || '').toLowerCase()] || null;
const EMERALD_CHANNEL_ID = commandDef('emerald')?.allowedChannel || '1433924050278682745';
const commandLabel = (id, fallback) => triggerFor(id) || fallback || id;
const matchAnywhereCommands = commandIds.filter((id) => !!commandDef(id)?.matchAnywhere);
const untrackedCommands = ['add', 'remove', 'message', 'whitelist', 'restart', 'メクッフィー']
  .map((id) => triggerFor(id))
  .filter(Boolean);
const tail = `\n\n||use ${triggerFor('join') || '?join'} to turn on notifications\nuse ${triggerFor('leave') || '?leave'} to turn off notifications||`;
const ttsScript = path.join(__dirname, 'tts_helper.py');
const ttsTempDir = path.join(__dirname, 'tts-cache');
const TTS_PREFIX_TIMEOUT_MS = 1 * 60 * 1000;
const VOICE_ALONE_TIMEOUT_MS = 5 * 60 * 1000;
const TTS_CACHE_MAX_BYTES = 1_000_000;
const guildDefaultVoiceChannels = new Map();
const isVoiceBasedChannel = (channel) => {
  if (!channel) return false;
  if (typeof channel.isVoiceBased === 'function') return channel.isVoiceBased();
  return channel.type === 2 || channel.type === 13;
};
const loadGuildDefaultVoiceChannels = () => {
  ensureDataDirs();
  guildDefaultVoiceChannels.clear();
  const serverDir = path.join(DEFAULT_BASE_DIR, 'servers');
  let entries = [];
  try {
    entries = fs.readdirSync(serverDir, { withFileTypes: true });
  } catch (err) {
    console.warn('failed to read guild voice default config directory:', err?.message || err);
    return guildDefaultVoiceChannels;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const guildId = entry.name.slice(0, -5);
    const data = readServerData(guildId, { fallback: null });
    const channelId = data?.voice?.defaultChannelId || data?.defaultVoiceChannelId || null;
    if (!channelId) continue;
    guildDefaultVoiceChannels.set(guildId, String(channelId));
  }
  return guildDefaultVoiceChannels;
};
const getDefaultVoiceChannelId = (guildId) => {
  const key = String(guildId || '').trim();
  if (!key) return null;
  return guildDefaultVoiceChannels.get(key) || null;
};
const validateGuildDefaultVoiceChannels = async () => {
  for (const [guildId, channelId] of [...guildDefaultVoiceChannels.entries()]) {
    let channel = client.channels.cache.get(channelId) || null;
    if (!channel) {
      try {
        channel = await client.channels.fetch(channelId);
      } catch (err) {
        console.warn(
          `[voice] removing invalid default voice channel ${channelId} for guild ${guildId}; channel fetch failed:`,
          err?.message || err
        );
        guildDefaultVoiceChannels.delete(guildId);
        continue;
      }
    }
    if (!isVoiceBasedChannel(channel)) {
      console.warn(
        `[voice] removing invalid default voice channel ${channelId} for guild ${guildId}; channel is not voice based`
      );
      guildDefaultVoiceChannels.delete(guildId);
      continue;
    }
    const channelGuildId = channel.guild?.id || null;
    if (channelGuildId !== guildId) {
      console.warn(
        `[voice] removing invalid default voice channel ${channelId} for guild ${guildId}; channel belongs to guild ${channelGuildId || 'unknown'}`
      );
      guildDefaultVoiceChannels.delete(guildId);
      continue;
    }
    console.log(`[voice] validated default voice channel ${channelId} for guild ${guildId}`);
  }
};
loadGuildDefaultVoiceChannels();
const findLocalFfmpeg = () => {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  const ttsFfmpeg = (() => {
    try {
      const entries = fs.readdirSync(ttsTempDir, { withFileTypes: true });
      const match = entries.find((e) => e.isDirectory() && e.name.toLowerCase().includes('ffmpeg'));
      if (match) {
        const bin = path.join(ttsTempDir, match.name, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(bin)) return bin;
      }
      const direct = path.join(ttsTempDir, 'ffmpeg.exe');
      if (fs.existsSync(direct)) return direct;
      const subfiles = fs.readdirSync(ttsTempDir).filter((f) => f.toLowerCase().endsWith('.exe'));
      const exe = subfiles.find((f) => f.toLowerCase().includes('ffmpeg'));
      if (exe) return path.join(ttsTempDir, exe);
    } catch (_) {
      // ignore
    }
    return null;
  })();
  if (ttsFfmpeg) candidates.push(ttsFfmpeg);
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath) candidates.push(staticPath.path || staticPath);
  } catch (_) {
    // ignore
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
};
const ffmpegPath = findLocalFfmpeg();
if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
  prism.FFmpeg.command = ffmpegPath;
} else {
  console.warn('ffmpeg not found; voice playback will fail until ffmpeg is installed');
}
process.title = 'boargalos';
const logDir = path.join(__dirname, 'logs');
const messageFile = path.join(__dirname, 'message.json');
const dedupe = (items) => [...new Set((items || []).map((item) => String(item).trim()).filter(Boolean))];
const pickRandom = (items) =>
  Array.isArray(items) && items.length ? items[Math.floor(Math.random() * items.length)] : null;
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ensureDir = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`failed to create dir ${dir}:`, err?.message || err);
  }
};
const logIssue = (type, err) => {
  ensureDir(logDir);
  const now = formatTimestamp(new Date());
  const filePath = path.join(logDir, `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}.log`);
  const lines = [
    `[${now}] [${type}] ${err?.message || err}`,
    err?.stack ? String(err.stack) : ''
  ].filter(Boolean);
  try {
    fs.appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  } catch (_) {
    // ignore file log errors
  }
};
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.warn = (...args) => {
  originalWarn(...args);
  try {
    const merged = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : String(a))).join(' ');
    logIssue('warn', new Error(merged));
  } catch (_) {
    // ignore logging failure
  }
};
console.error = (...args) => {
  originalError(...args);
  try {
    const merged = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : String(a))).join(' ');
    logIssue('error', new Error(merged));
  } catch (_) {
    // ignore logging failure
  }
};
const replaceSpoilersWithBlank = (text) => String(text || '').replace(/\|\|[^|]*\|\|/g, 'blank');
async function replaceMentionsWithNames(content, message) {
  const input = String(content || '');
  const ids = [...new Set((input.match(/<@!?\d+>/g) || []).map((m) => m.replace(/\D/g, '')))];
  if (!ids.length) return input;
  const cache = new Map();
  const getName = async (id) => {
    if (cache.has(id)) return cache.get(id);
    const mentionUser = message?.mentions?.users?.get(id);
    if (mentionUser?.username) {
      cache.set(id, mentionUser.username);
      return mentionUser.username;
    }
    const guildUser = message?.guild?.members?.cache?.get(id)?.user;
    if (guildUser?.username) {
      cache.set(id, guildUser.username);
      return guildUser.username;
    }
    const cachedUser = client.users.cache.get(id);
    if (cachedUser?.username) {
      cache.set(id, cachedUser.username);
      return cachedUser.username;
    }
    try {
      const fetched = await client.users.fetch(id);
      if (fetched?.username) {
        cache.set(id, fetched.username);
        return fetched.username;
      }
    } catch (err) {
      // ignore fetch failure
    }
    return null;
  };
  let result = input;
  for (const id of ids) {
    const name = await getName(id);
    const replacement = name ? `at ${name}` : `at user ${id}`;
    result = result.replace(new RegExp(`<@!?${id}>`, 'g'), replacement);
  }
  return result;
}
const voice = createVoiceManager({
  client,
  ensureDir,
  replaceMentionsWithNames,
  replaceSpoilersWithBlank,
  ttsScript,
  ttsTempDir,
  getDefaultVoiceChannelId,
  TTS_PREFIX_TIMEOUT_MS,
  VOICE_ALONE_TIMEOUT_MS,
  TTS_CACHE_MAX_BYTES
});
const readJSON = (filePath) => {
  try {
    return JSON5.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
};
const safeWriteJSON = (filePath, data) => {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.warn(`failed to write ${filePath}:`, err?.message || err);
  }
};
const escapeUnderscores = (value) => {
  if (!value) return '';
  return String(value).replace(/_/g, '\\_');
};
const truncateText = (value, maxLength = 1400) => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};
const formatProcessOutput = (value) => {
  const text = truncateText(value);
  if (!text) return '';
  return `\n\`\`\`\n${text.replace(/```/g, '```\u200b')}\n\`\`\``;
};
const normalizeSiteBlockTarget = (value) =>
  String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^\/+/, '');
const runSpawnedProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
const resolveSiteBlockTargets = (rawInput) => {
  const targets = String(rawInput || '')
    .split(/\s+/)
    .map((item) => normalizeSiteBlockTarget(item))
    .filter(Boolean);
  if (!targets.length) return null;
  if (targets.length === 1 && targets[0].toLowerCase() === 'twitter') {
    return {
      label: 'twitter',
      urls: [...TWITTER_SITE_BLOCK_DOMAINS]
    };
  }
  return {
    label: targets.length === 1 ? targets[0] : `${targets.length} urls`,
    urls: targets
  };
};
const runSiteBlockAction = async (action, urls) => {
  const result = await runSpawnedProcess('py', [TWITTER_SITE_BLOCK_CLI, action, ...urls], {
    cwd: __dirname
  });
  if (result.code !== 0) {
    const detail = result.stderr || result.stdout || `exit code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout || result.stderr;
};
const pad2 = (value) => String(value).padStart(2, '0');
const formatDateShort = (date) => `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
const normalizeAliasKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const resolveAliasZone = (value) => {
  const lower = String(value || '').toLowerCase();
  const normalized = normalizeAliasKey(value);
  return timezoneAliases[normalized] || timezoneAliases[lower] || null;
};
const dailyReminderTask = {
  userId: '850976200562311168',
  zone: resolveAliasZone('pst') || 'America/Los_Angeles',
  hour: '07',
  minute: '00',
  message: 'meds :)'
};
const dailyReminderTask2 = {
  userId: '850976200562311168',
  zone: resolveAliasZone('pst') || 'America/Los_Angeles',
  hour: '20',
  minute: '00',
  message: 'lithium <3'
};
const uniqueAliasZones = () => [...new Set(Object.values(timezoneAliases || {}))];
const responses = JSON5.parse(fs.readFileSync(responsesFile, 'utf8'));
const JAY_LINES = Array.isArray(responses?.jayLines) ? responses.jayLines : [];
let mentionList = dedupe(JSON5.parse(fs.readFileSync(mentionsFile, 'utf8')));
let whitelistUserIds = dedupe(JSON5.parse(fs.readFileSync(whitelistFile, 'utf8')));
let savedMessage = normalizeMessageText(JSON5.parse(fs.readFileSync(messageFile, 'utf8')).message);
let stats = JSON5.parse(fs.readFileSync(statsFile, 'utf8'));
let legacyRemindersHandled = false;
const SUPPORTED_CONVERT_UNITS = ['c', 'f', 'cm', 'in', 'ft', 'm', 'kg', 'lb', 'mph', 'kph', 'ft2', 'm2'];
const helpPages = [
  [
    '**Help: Basics**',
    '?help - show this menu',
    '?join / ?leave - toggle pings',
    '?cam / ?mic - toggle your camera and mic permissions',
    '?mentions - show mentions list',
    '?stats - bot statistics',
    '?time <add|edit|remove|user> - manage time preferences',
    '?convert <amount> <from> <to> - convert units'
  ].join('\n'),
  [
    '**Help: Reminders & Messages**',
    '?remindme <on|off> - toggle reminders',
    '?remind <user> <message> - send a reminder',
    '?add <mentions|whitelist|reminders> <user> - add to lists (whitelist; owner for whitelist/reminders)',
    '?remove <user> - remove from mentions (whitelist)',
    '?message <edit|remove|display [message]> - manage the saved message (whitelist)',
    '?powerup - send the powerup ping (whitelist)',
    '?whitelist - show whitelisted users',
    '?reply <messageId> <message> - reply to a message by id'
  ].join('\n'),
  [
    '**Help: Voice, TTS & Admin**',
    '?joinvc / ?leavevc - join or leave the TTS voice channel',
    '?tts <text> - speak a message',
    '?pausetts / ?resumetts / ?stoptts - control playback',
    '?cache - clear cached TTS clips (owner)',
    '?status <message> - set the voice channel status',
    '?edit <messageId> <new text> - edit a message (owner)',
    '?delete <messageId> - delete a message (owner)',
    '?restart - restart the bot (owner)'
  ].join('\n')
];
let timePrefs = {};
let legacyTimezonesHandled = false;
stats.commands = stats.commands || {};
stats.userMessages = stats.userMessages || {};
stats.totalMessages = stats.totalMessages || 0;
stats.timesPinged = stats.timesPinged || 0;
stats.totalMentions = stats.totalMentions || 0;
stats.maxUsers = stats.maxUsers || mentionList.length;

client.once(Events.ClientReady, async () => {
  console.log(`[ready] ${client.user.username} connected. Mentions loaded: ${mentionList.length}`);
  //scheduleDailyReminder(dailyReminderTask);
  //scheduleDailyReminder2(dailyReminderTask2);
  await validateGuildDefaultVoiceChannels();
  await restoreVoiceSessions();
  setInterval(() => {
    checkIdleVoices().catch((err) => console.warn('idle voice check failed:', err?.message || err));
  }, 60 * 1000);
});

const gracefulShutdown = (reason) => {
  try {
    persistVoiceSessionsIfAny();
  } catch (err) {
    console.warn('failed to persist voice sessions on shutdown:', err?.message || err);
    logIssue('shutdown-persist', err);
  }
  if (reason === 'exit') return;
  setTimeout(() => process.exit(0), 200);
};
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => {
  process.on(signal, () => gracefulShutdown(signal));
});
process.on('warning', (warning) => {
  console.warn('Process warning:', warning?.message || warning);
  logIssue('warning', warning);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  logIssue('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  gracefulShutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  logIssue('uncaughtException', err);
  gracefulShutdown('uncaughtException');
});
process.on('exit', () => gracefulShutdown('exit'));

function normalizeMessageText(text) {
  if (!text) return '';
  const str = String(text);
  if (str.endsWith(tail)) {
    return str.slice(0, str.length - tail.length).replace(/\s+$/, '');
  }
  return str;
}

const saveMessageText = (text) => {
  savedMessage = normalizeMessageText(text);
  fs.writeFileSync(messageFile, JSON.stringify({ message: savedMessage }, null, 2), 'utf8');
  return savedMessage;
};

const formatResponse = (template, vars = {}) =>
  String(template || '').replace(/{{(\w+)}}/g, (m, key) => (key in vars ? vars[key] : m));
const resolveResponseTemplate = (key) => {
  const value = responses[key];
  if (Array.isArray(value)) return value.join('');
  return value || key;
};
const getResponse = (key, vars) => formatResponse(resolveResponseTemplate(key), vars);
const archiveLegacyReminderFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const base = `${filePath}.legacy`;
  let target = base;
  if (fs.existsSync(target)) {
    target = `${base}.${Date.now()}`;
  }
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch (err) {
    try {
      fs.copyFileSync(filePath, target);
      fs.unlinkSync(filePath);
      return target;
    } catch (innerErr) {
      console.warn('failed to archive legacy reminder file:', innerErr?.message || innerErr);
    }
  }
  return null;
};
const ensureReminderDataReady = () => {
  if (legacyRemindersHandled) return;
  if (!fs.existsSync(remindFile) && !fs.existsSync(remindQueueFile)) {
    legacyRemindersHandled = true;
    return;
  }
  ensureDataDirs();
  let hasReminderData = false;
  const userDir = path.join(DEFAULT_BASE_DIR, 'users');
  try {
    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const data = readJsonFile(path.join(userDir, entry.name), { fallback: null });
      if (!data || typeof data !== 'object') continue;
      if (typeof data.remindersEnabled === 'boolean' || Array.isArray(data.reminderQueue)) {
        hasReminderData = true;
        break;
      }
    }
  } catch (err) {
    console.warn('failed to scan user reminder data:', err?.message || err);
  }
  if (!hasReminderData) {
    const legacyPrefs = readJsonFile(remindFile, { fallback: null });
    const enabled = Array.isArray(legacyPrefs?.enabled) ? legacyPrefs.enabled : [];
    enabled.forEach((userId) => {
      if (!userId) return;
      updateUserData(userId, (current) => ({ ...(current || {}), remindersEnabled: true }));
    });
    const legacyQueue = readJsonFile(remindQueueFile, { fallback: null });
    if (legacyQueue && typeof legacyQueue === 'object') {
      Object.entries(legacyQueue).forEach(([userId, queue]) => {
        if (!userId || !Array.isArray(queue)) return;
        updateUserData(userId, (current) => {
          const existing = Array.isArray(current?.reminderQueue) ? current.reminderQueue : [];
          const merged = existing.length ? existing.concat(queue) : queue;
          return { ...(current || {}), reminderQueue: merged };
        });
      });
    }
  }
  if (fs.existsSync(remindFile)) archiveLegacyReminderFile(remindFile);
  if (fs.existsSync(remindQueueFile)) archiveLegacyReminderFile(remindQueueFile);
  legacyRemindersHandled = true;
};
const normalizeReminderQueue = (queue) => (Array.isArray(queue) ? queue.filter(Boolean) : []);
const saveRemindQueue = (userId, queue) => {
  if (!userId) return [];
  ensureReminderDataReady();
  const normalized = normalizeReminderQueue(queue);
  updateUserData(userId, (current) => ({ ...(current || {}), reminderQueue: normalized }));
  return normalized;
};
const saveMentionList = () => fs.writeFileSync(mentionsFile, JSON.stringify(mentionList, null, 2), 'utf8');
const saveRemindPrefs = (userId, enabled) => {
  if (!userId) return false;
  ensureReminderDataReady();
  const value = !!enabled;
  updateUserData(userId, (current) => ({ ...(current || {}), remindersEnabled: value }));
  return value;
};
const isValidTimeZone = (zone) => {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
    return true;
  } catch (err) {
    return false;
  }
};
function normalizeTimePrefs(data = {}) {
  const clean = {};
  Object.entries(data || {}).forEach(([userId, entry]) => {
    if (!entry) return;
    const raw = entry.raw || entry.timeZone || '';
    let zone = resolveAliasZone(raw) || resolveAliasZone(entry.timeZone);
    if (!zone && entry.timeZone && isValidTimeZone(entry.timeZone)) zone = entry.timeZone;
    if (zone) {
      clean[userId] = {
        type: 'timezone',
        timeZone: zone,
        raw,
        setAt: entry.setAt || Date.now()
      };
      return;
    }
    if (Number.isFinite(entry.offsetMinutes)) {
      clean[userId] = {
        type: 'offset',
        offsetMinutes: entry.offsetMinutes,
        raw,
        setAt: entry.setAt || Date.now()
      };
    }
  });
  return clean;
}
const getZoneDateParts = (zone, date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);
  const lookup = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute')
  };
};
const zonedTimeToUtcMs = (zone, year, month, day, hour, minute) => {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffsetMinutes(zone, new Date(guess)) ?? 0;
    const nextGuess = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
    if (Math.abs(nextGuess - guess) < 1000) {
      guess = nextGuess;
      break;
    }
    guess = nextGuess;
  }
  return guess;
};
const nextDailyOccurrenceMs = (zone, hour = 7, minute = 0) => {
  if (!isValidTimeZone(zone)) return null;
  const now = new Date();
  const { year, month, day } = getZoneDateParts(zone, now);
  let targetMs = zonedTimeToUtcMs(zone, year, month, day, hour, minute);
  if (targetMs <= now.getTime()) {
    const next = new Date(Date.UTC(year, month - 1, day, 12) + 86400000);
    const nextParts = getZoneDateParts(zone, next);
    targetMs = zonedTimeToUtcMs(zone, nextParts.year, nextParts.month, nextParts.day, hour, minute);
  }
  return targetMs;
};
const zoneForOffset = (offsetMinutes) => {
  if (!Number.isFinite(offsetMinutes)) return null;
  const zones = uniqueAliasZones();
  const now = new Date();
  for (const zone of zones) {
    const zOffset = zoneOffsetMinutes(zone, now);
    if (zOffset === offsetMinutes) return zone;
  }
  return null;
};
const archiveLegacyTimePrefs = () => {
  if (!fs.existsSync(timePrefsFile)) return null;
  const base = `${timePrefsFile}.legacy`;
  let target = base;
  if (fs.existsSync(target)) {
    target = `${base}.${Date.now()}`;
  }
  try {
    fs.renameSync(timePrefsFile, target);
    return target;
  } catch (err) {
    try {
      fs.copyFileSync(timePrefsFile, target);
      fs.unlinkSync(timePrefsFile);
      return target;
    } catch (innerErr) {
      console.warn('failed to archive legacy time prefs:', innerErr?.message || innerErr);
    }
  }
  return null;
};
function loadTimePrefs() {
  ensureDataDirs();
  const prefs = {};
  const userDir = path.join(DEFAULT_BASE_DIR, 'users');
  let entries = [];
  try {
    entries = fs.readdirSync(userDir, { withFileTypes: true });
  } catch (err) {
    console.warn('failed to read user data directory:', err?.message || err);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    const userId = entry.name.slice(0, -5);
    const data = readJsonFile(path.join(userDir, entry.name), { fallback: null });
    if (!data || typeof data !== 'object') continue;
    if (data.timePrefs) prefs[userId] = data.timePrefs;
  }
  if (!legacyTimezonesHandled && fs.existsSync(timePrefsFile)) {
    if (!Object.keys(prefs).length) {
      const legacy = readJsonFile(timePrefsFile, { fallback: null });
      const legacyPrefs = normalizeTimePrefs(legacy || {});
      Object.entries(legacyPrefs).forEach(([userId, entry]) => {
        const existing = readUserData(userId, { fallback: null });
        if (existing?.timePrefs) return;
        updateUserData(userId, (current) => ({ ...(current || {}), timePrefs: entry }));
        prefs[userId] = entry;
      });
    }
    archiveLegacyTimePrefs();
    legacyTimezonesHandled = true;
  }
  return normalizeTimePrefs(prefs);
}
const saveTimePrefs = (next = timePrefs) => {
  const previous = timePrefs || {};
  const cleaned = normalizeTimePrefs(next || {});
  timePrefs = cleaned;
  const nextIds = new Set(Object.keys(cleaned));
  const prevIds = new Set(Object.keys(previous));
  for (const [userId, entry] of Object.entries(cleaned)) {
    updateUserData(userId, (current) => ({ ...(current || {}), timePrefs: entry }));
  }
  for (const userId of prevIds) {
    if (nextIds.has(userId)) continue;
    updateUserData(userId, (current) => {
      const nextData = { ...(current || {}) };
      delete nextData.timePrefs;
      return nextData;
    });
  }
  return timePrefs;
};
const getUserTimePref = (userId) => {
  if (!userId) return null;
  if (timePrefs[userId]) return timePrefs[userId];
  const data = readUserData(userId, { fallback: null });
  const entry = data?.timePrefs;
  if (!entry) return null;
  const normalized = normalizeTimePrefs({ [userId]: entry })[userId] || null;
  if (normalized) timePrefs[userId] = normalized;
  return normalized;
};
timePrefs = loadTimePrefs();
const parseClockInput = (raw) => {
  const match = String(raw || '')
    .trim()
    .match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridian = match[3]?.toLowerCase();
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  if (minutes > 59) return null;
  if (meridian) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (meridian === 'pm') hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return { hours, minutes };
};
const computeOffsetFromClock = (hours, minutes) => {
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const now = new Date();
  const desiredMinutes = hours * 60 + minutes;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offsetMinutes = desiredMinutes - utcMinutes;
  if (offsetMinutes <= -720) offsetMinutes += 1440;
  if (offsetMinutes > 720) offsetMinutes -= 1440;
  return offsetMinutes;
};
function parseTimeInput(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const clock = parseClockInput(value);
  if (clock) {
    const offsetMinutes = computeOffsetFromClock(clock.hours, clock.minutes);
    const zone = zoneForOffset(offsetMinutes);
    if (zone && isValidTimeZone(zone)) {
      return { type: 'timezone', timeZone: zone, raw: value };
    }
    return null;
  }
  const zone = resolveAliasZone(value);
  if (!zone) return null;
  if (!isValidTimeZone(zone)) return null;
  return { type: 'timezone', timeZone: zone, raw: value };
}
function zoneOffsetMinutes(zone, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date);
    const lookup = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const zonedUtc = Date.UTC(
      lookup('year'),
      lookup('month') - 1,
      lookup('day'),
      lookup('hour'),
      lookup('minute'),
      lookup('second')
    );
    return Math.round((zonedUtc - date.getTime()) / 60000);
  } catch (err) {
    console.warn('failed to derive timezone offset:', err?.message || err);
    return null;
  }
}
const findDstTransitions = (zone, year) => {
  const transitions = [];
  let prevOffset = zoneOffsetMinutes(zone, new Date(Date.UTC(year, 0, 1, 12, 0)));
  for (let month = 0; month < 12; month++) {
    for (let day = 1; day <= 31; day++) {
      const probe = new Date(Date.UTC(year, month, day, 12, 0));
      if (probe.getUTCMonth() !== month) break;
      const offset = zoneOffsetMinutes(zone, probe);
      if (offset !== prevOffset && offset !== null && prevOffset !== null) {
        transitions.push({ date: probe, from: prevOffset, to: offset });
        if (transitions.length >= 2) return transitions;
      }
      prevOffset = offset;
    }
  }
  return transitions;
};
function getDstInfo(zone, date = new Date()) {
  if (!zone) return null;
  const year = date.getFullYear();
  const currentOffset = zoneOffsetMinutes(zone, date);
  const janOffset = zoneOffsetMinutes(zone, new Date(Date.UTC(year, 0, 1, 12, 0)));
  const julOffset = zoneOffsetMinutes(zone, new Date(Date.UTC(year, 6, 1, 12, 0)));
  if (currentOffset === null || janOffset === null || julOffset === null) return null;
  if (janOffset === julOffset) return { hasDst: false, isDst: false, label: '' };
  const transitions = findDstTransitions(zone, year);
  const offsetSamples = transitions.reduce(
    (acc, t) => {
      acc.push(t.from, t.to);
      return acc;
    },
    [janOffset, julOffset]
  );
  const dstOffset = Math.max(...offsetSamples);
  const stdOffset = Math.min(...offsetSamples);
  const isDst = currentOffset === dstOffset;
  const startTransition = transitions.find((t) => t.to === dstOffset) || null;
  const endTransition =
    transitions.find((t) => t.to === stdOffset && t.from === dstOffset) ||
    transitions.find((t) => t.to === stdOffset) ||
    null;
  const startLabel = startTransition ? formatDateShort(startTransition.date) : null;
  const endLabel = endTransition ? formatDateShort(endTransition.date) : null;
  let label = '';
  if (isDst) {
    label = endLabel ? `DST in effect (ends ${endLabel})` : 'DST in effect';
  } else {
    label = startLabel ? `Standard time (DST starts ${startLabel})` : 'Standard time';
  }
  return { hasDst: true, isDst, label, dstOffset, stdOffset };
}
const extractTimeEntry = (value) => {
  if (!value) return null;
  if (value.timePrefs && typeof value.timePrefs === 'object') return value.timePrefs;
  return value;
};
const formatTimeEntry = (value) => {
  const entry = extractTimeEntry(value);
  if (!entry) return null;
  const now = new Date();
  if (entry.timeZone) {
    try {
      const parts24 = new Intl.DateTimeFormat('en-US', {
        timeZone: entry.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(now);
      const parts12 = new Intl.DateTimeFormat('en-US', {
        timeZone: entry.timeZone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).formatToParts(now);
      const hhRaw = parts24.find((p) => p.type === 'hour')?.value || '00';
      const hh = hhRaw === '24' ? '00' : hhRaw;
      const mm = parts24.find((p) => p.type === 'minute')?.value || '00';
      const h12Raw = parts12.find((p) => p.type === 'hour')?.value || hh;
      const h12 = pad2(Number(h12Raw) || h12Raw);
      const mm12 = parts12.find((p) => p.type === 'minute')?.value || mm;
      const dp = (parts12.find((p) => p.type === 'dayPeriod')?.value || '').toLowerCase();
      return {
        time: `${hh}:${mm}`,
        time12: `${h12}:${mm12} ${dp}`.trim()
      };
    } catch (err) {
      console.warn('failed to format timezone time:', err?.message || err);
      return null;
    }
  }
  if (!Number.isFinite(entry.offsetMinutes)) return null;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const target = new Date(utcMs + entry.offsetMinutes * 60000);
  const hours = target.getUTCHours();
  const minutes = target.getUTCMinutes();
  const hh = pad2(hours % 24);
  const mm = pad2(minutes);
  const h12 = pad2(hours % 12 || 12);
  const dp = hours >= 12 ? 'pm' : 'am';
  return {
    time: `${hh}:${mm}`,
    time12: `${h12}:${mm} ${dp}`
  };
};
const bumpMessageCount = (message) => {
  const userId = message.author?.id;
  if (!userId) return;
  stats.totalMessages += 1;
  if (!stats.userMessages[userId]) stats.userMessages[userId] = 0;
  stats.userMessages[userId] += 1;
  saveStats(stats);
};

function isRemindEnabled(userId) {
  if (!userId) return false;
  ensureReminderDataReady();
  const data = readUserData(userId, { fallback: null });
  if (typeof data?.remindersEnabled === 'boolean') return data.remindersEnabled;
  return false;
}


async function deliverPendingReminders(message) {
  const userId = message.author?.id;
  if (!userId) return;
  ensureReminderDataReady();
  const data = readUserData(userId, { fallback: null });
  const pending = Array.isArray(data?.reminderQueue) ? data.reminderQueue : [];
  if (!pending.length) return;
  if (!data?.remindersEnabled) return;
  const remaining = [];
  for (const entry of pending) {
    const content = entry?.body || '';
    if (!content) continue;
    try {
      await sendReply(message, content);
    } catch (err) {
      console.warn('failed to deliver reminder:', err?.message || err);
      remaining.push(entry);
    }
  }
  saveRemindQueue(userId, remaining);
}

function extractUserId(text) {
  if (!text) return null;
  const mentionMatch = String(text).match(/<@!?(\d+)>/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = String(text).match(/\b\d{15,}\b/);
  if (idMatch) return idMatch[0];
  return null;
}

const bigramScore = (a, b) => {
  if (!a || !b) return 0;
  const grams = (s) => {
    const r = new Set();
    for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2));
    return r;
  };
  const A = grams(a.toLowerCase());
  const B = grams(b.toLowerCase());
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((g) => {
    if (B.has(g)) inter += 1;
  });
  return (2 * inter) / (A.size + B.size);
};

async function bestUserMatch(message, token) {
  const query = String(token || '').toLowerCase();
  if (!query) return null;
  // ignore very short/non-name tokens to reduce false positives
  if (query.length <= 2) return null;
  const counts = stats.userMessages || {};
  const authorId = message?.author?.id || null;
  let best = null;
  let bestNonSelf = null;
  const seen = new Set();
  const scoreMember = (member) => {
    if (!member?.user?.id || seen.has(member.user.id)) return;
    seen.add(member.user.id);
    const names = [member.user?.username || '', member.nickname || '', member.displayName || ''].filter(Boolean);
    let nameScore = 0;
    for (const name of names) {
      const lower = name.toLowerCase();
      let s = bigramScore(query, lower);
      if (lower === query) s += 2;
      else if (lower.startsWith(query)) s += 0.5;
      else if (lower.includes(query)) s += 0.2;
      nameScore = Math.max(nameScore, s);
    }
    const hasSubstr = names.some((n) => n.toLowerCase().includes(query));
    if (nameScore <= 0 && !hasSubstr) return;
    const weight = Math.log1p(counts[member.user.id] || 0) / 5;
    let score = nameScore + weight;
    const isSelf = authorId && member.user.id === authorId;
    if (isSelf) {
      score *= hasSubstr ? 0.7 : 0.4; // always downrank self, harder if no substring
    }
    const candidate = { id: member.user.id, score };
    if (!best || score > best.score) best = candidate;
    if (!isSelf && (!bestNonSelf || score > bestNonSelf.score)) bestNonSelf = candidate;
  };
  if (message?.guild) {
    message.guild.members.cache.forEach((member) => scoreMember(member));
    try {
      const fetched = await message.guild.members.fetch({ query: token, limit: 100 });
      fetched.forEach((member) => scoreMember(member));
    } catch (err) {
      console.warn('fetch match failed:', err?.message || err);
    }
  } else {
    client.users.cache.forEach((user) => scoreMember({ user }));
  }
  const pick = bestNonSelf || best;
  if (!pick || pick.score < 0.25) return null;
  return pick.id;
}

async function resolveUserTarget(message, token) {
  const tokenText = String(token || '').trim();
  const cleanedToken = tokenText.replace(/^@+/, '');
  const directId = extractUserId(cleanedToken);
  if (directId) return { id: directId, mention: `<@${directId}>` };
  if (!cleanedToken) return null;
  const bestId = await bestUserMatch(message, cleanedToken);
  return bestId ? { id: bestId, mention: `<@${bestId}>` } : null;
}
const saveStats = (next = stats) => {
  stats = next;
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf8');
  return stats;
};

const recordCommandUsage = (command) => {
  if (!command) return;
  if (!stats.commands[command]) stats.commands[command] = 0;
  stats.commands[command] += 1;
  if (command === (triggerFor('powerup') || '?powerup')) {
    stats.timesPinged += 1;
    stats.totalMentions += mentionList.length;
  }
  saveStats(stats);
};

const syncMaxUsers = () => {
  stats.maxUsers = Math.max(stats.maxUsers || 0, mentionList.length);
  saveStats(stats);
};

const saveWhitelist = (list = whitelistUserIds) => {
  whitelistUserIds = dedupe(list.concat([AUTHORIZED_USER_ID]));
  fs.writeFileSync(whitelistFile, JSON.stringify(whitelistUserIds, null, 2), 'utf8');
};

function renderMentionList(extraText) {
  if (!mentionList.length) return getResponse('noMentions');
  const mentions = mentionList.join('');
  const body = (extraText || savedMessage || '').trim();
  if (body) return `${mentions} ${body}${tail}`;
  return `${mentions}${tail}`;
}

function renderMentionBlock() {
  if (!mentionList.length) return getResponse('noMentionsBlock');
  return `\`\`\`\n${mentionList.join('')}\n\`\`\``;
}

function renderHelpText() {
  return helpPages.join('\n\n');
}

function renderStats() {
  const entries = Object.entries(stats.commands || {})
    .filter(([cmd]) => !untrackedCommands.includes(cmd))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = entries.slice(0, 3);
  const line = (idx, item) => `${idx}. ${(item && item[0]) || 'n/a'} (${(item && item[1]) || 0})`;
  return [
    '## Command stats:',
    line(1, top[0]),
    line(2, top[1]),
    line(3, top[2]),
    '',
    `Total mentions: ${stats?.totalMentions ?? 0}`,
    `Times pinged: ${stats?.timesPinged ?? 0}`,
    `Current users: ${mentionList.length}`,
    `Max users: ${stats?.maxUsers ?? mentionList.length}`
  ].join('\n');
}

async function sendMessage(target, content) {
  const payload = typeof content === 'string' ? { content } : content;
  if (!target) return null;
  if (target.isRepliable?.()) {
    try {
      if (target.replied || target.deferred) return await target.followUp(payload);
      return await target.reply(payload);
    } catch (err) {
      console.warn('failed to send interaction message:', err?.message || err);
      return null;
    }
  }
  if (target.channel?.send) {
    try {
      return await target.channel.send(payload);
    } catch (err) {
      console.warn('failed to send message:', err?.message || err);
      return null;
    }
  }
  return null;
}

async function sendReply(target, content, options = {}) {
  let payload = typeof content === 'string' ? { content } : { ...(content || {}) };
  if (options && typeof options === 'object') {
    const extra = { ...options };
    delete extra.ephemeral;
    payload = { ...payload, ...extra };
  }
  if (payload && typeof payload === 'object' && 'ephemeral' in payload) {
    delete payload.ephemeral;
  }
  if (!target) return null;
  if (target.reply) {
    try {
      return await target.reply({ ...payload, allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.warn('failed to reply ', err?.message || err);
      return sendMessage(target, payload);
    }
  }
  return sendMessage(target, payload);
}

function ensureLogDir() {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.warn('failed to ensure log dir:', err?.message || err);
  }
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = String(date.getFullYear()).slice(-2);
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${d}.${m}.${y}-${h}:${min}`;
}

function appendCommandLog({ message, command }) {
  if (!message || !command) return;
  ensureLogDir();
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const filePath = path.join(logDir, `${year}-${month}.log`);
  const channelName = message.channel?.name || message.channelId || 'unknown-channel';
  const guildName = message.guild?.name || message.guild?.id || (message.guildId ? `guild-${message.guildId}` : 'DM');
  const userLabel = escapeUnderscores(
    message.author?.username ||
      message.user?.username ||
      message.author?.id ||
      message.user?.id ||
      'unknown-user'
  );
  const line = `[${formatTimestamp(now)}] ${command} ran in ${channelName}, ${guildName} by ${userLabel}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    console.warn('failed to write command log:', err?.message || err);
  }
}

function restartBot() {
  try {
    const child = spawn('cmd', ['/c', 'start', '""', 'start.bat'], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (err) {
    console.warn('failed to restart:', err?.message || err);
  }
  setTimeout(() => process.exit(0), 500);
}

async function handleRemove(message) {
  const token = (message.content || '').split(/\s+/)[1] || '';
  const target = await resolveUserTarget(message, token);
  if (!target) return sendReply(message, getResponse('noId'));
  const before = mentionList.length;
  mentionList = mentionList.filter((item) => item !== target.mention);
  if (mentionList.length === before) {
    return sendReply(message, getResponse('notInList', { target: target.mention }));
  }
  saveMentionList();
  return sendReply(message, getResponse('removedMention', { target: target.mention }));
}

function enqueueReminder(targetId, entry) {
  const id = String(targetId || '').trim();
  if (!id) return;
  ensureReminderDataReady();
  updateUserData(id, (current) => {
    const queue = Array.isArray(current?.reminderQueue) ? current.reminderQueue.slice() : [];
    queue.push(entry);
    return { ...(current || {}), reminderQueue: queue };
  });
}

const actionHandlers = {};

const logCommandRun = (message, id, keyword, suffix) => {
  const base = commandLabel(id, keyword);
  const label = suffix ? `${base} ${suffix}` : base;
  recordCommandUsage(base);
  appendCommandLog({ message, command: label });
};

const resolveSelfToggleRole = async (guild, roleKey) => {
  const config = SELF_TOGGLE_ROLE_CONFIG[roleKey];
  if (!guild || !config) return null;
  let role = guild.roles?.cache?.get(config.roleId) || null;
  if (!role && guild.roles?.fetch) {
    try {
      role = await guild.roles.fetch(config.roleId);
    } catch (err) {
      console.warn(`failed to fetch ${roleKey} role by id ${config.roleId}:`, err?.message || err);
    }
  }
  return role;
};

const monitorKeywordAlerts = async (message, { isDm, guildId, channelId }) => {
  if (isDm) return;
  if (guildId !== KEYWORD_ALERT_GUILD_ID || channelId !== KEYWORD_ALERT_CHANNEL_ID) return;
  const content = String(message.content || '').toLowerCase();
  if (!content) return;
  const matches = KEYWORD_ALERT_TERMS.filter((term) => content.includes(term));
  if (!matches.length) return;
  try {
    const user = await client.users.fetch(KEYWORD_ALERT_USER_ID);
    const authorTag = message.author?.tag || message.author?.username || 'unknown';
    const jump = message.url || `(channel ${channelId})`;
    const attachments = Array.from(message.attachments?.values?.() || []).map((a) => a.url || a.proxyURL).filter(Boolean);
    const header = `Matched [${matches.join(', ')}] in ${guildId}/${channelId} by ${authorTag}`;
    const bodyLines = [];
    if (message.content) bodyLines.push(message.content);
    if (attachments.length) {
      bodyLines.push('Attachments:');
      attachments.forEach((url) => bodyLines.push(url));
    }
    bodyLines.push(jump);
    const payload = [header, ...bodyLines].join('\n');
    // Forward the original message to the alert channel when possible.
    try {
      const dmChannel = await client.channels.fetch(KEYWORD_ALERT_DM_CHANNEL_ID);
      if (dmChannel && typeof dmChannel.isTextBased === 'function' ? dmChannel.isTextBased() : dmChannel.send) {
        await message.forward(dmChannel);
      } else {
        throw new Error('alert channel not text-based');
      }
    } catch (forwardErr) {
      console.warn('failed to forward keyword alert:', forwardErr?.message || forwardErr);
    }
    // Also DM the user with a summary for redundancy.
    try {
      await user.send(payload);
    } catch (dmErr) {
      console.warn('failed to DM keyword alert:', dmErr?.message || dmErr);
    }
    console.log(`[keyword-alert] forwarded match ${matches.join(', ')} from ${guildId}/${channelId} (${authorTag})`);
  } catch (err) {
    console.warn('failed to send keyword alert:', err?.message || err);
  }
};

const {
  getActiveVoiceState,
  collectCurrentVoiceSessions,
  restoreVoiceSessions,
  checkIdleVoices,
  persistVoiceSessionsIfAny,
  getOrCreateVoice,
  leaveVoice,
  stopPlayback,
  pausePlayback,
  resumePlayback,
  toggleTtsEnabled,
  handleAutoTts,
  getVoiceConnection
} = voice;

actionHandlers.simpleResponse = async ({ message, def, keyword, reply = false }) => {
  const body =
    def?.responseKey && responses[def.responseKey]
      ? getResponse(def.responseKey)
      : def?.response || '';
  if (!body) return;
  if (reply) {
    await sendReply(message, body);
  } else {
    await sendMessage(message, body);
  }
  logCommandRun(message, def?.id || def?.action, keyword);
};

actionHandlers.mcfe = async ({ message, def, keyword }) => {
  const mcfeResp = def?.responseKey ? getResponse(def.responseKey) : def?.response || getResponse('mcfePing');
  await sendMessage(message, mcfeResp);
  logCommandRun(message, 'mcfe', keyword);
};

actionHandlers.emerald = async ({ message, def, keyword, channelId }) => {
  if (!coupleUserIds.has(message.author?.id)) return;
  const allowed = def?.allowedChannel || EMERALD_CHANNEL_ID;
  if (allowed && channelId !== allowed) return;
  const body = def?.response || '';
  if (body) {
    await sendMessage(message, body);
  }
  logCommandRun(message, 'emerald', keyword);
};

actionHandlers.double = async ({ message, def, keyword }) => {
  const body = def?.response || '<:MindBlownBoar:1124479306853261362>';
  await sendReply(message, body);
  logCommandRun(message, 'double', keyword);
};

actionHandlers.help = async ({ message, keyword }) => {
  await sendReply(message, renderHelpText());
  logCommandRun(message, 'help', keyword);
};

actionHandlers.editMessage = async ({ message, rest, keyword }) => {
  const trimmed = rest.trim();
  const [targetId, ...bodyParts] = trimmed.split(/\s+/);
  const newBody = bodyParts.join(' ').trim();
  if (!targetId || !newBody) {
    await sendReply(message, getResponse('editUsage'), { ephemeral: true });
    logCommandRun(message, 'edit', keyword);
    return;
  }
  let targetMsg = null;
  try {
    targetMsg = await message.channel?.messages?.fetch(targetId);
  } catch (_) {
    // ignore fetch failure
  }
  if (!targetMsg) {
    await sendReply(message, getResponse('editNotFound'), { ephemeral: true });
    logCommandRun(message, 'edit', keyword);
    return;
  }
  try {
    await targetMsg.edit(newBody);
    await sendReply(message, getResponse('editSuccess'), { ephemeral: true });
  } catch (err) {
    console.warn('edit failed:', err?.message || err);
    await sendReply(message, getResponse('editFail'), { ephemeral: true });
  }
  logCommandRun(message, 'edit', keyword);
};

actionHandlers.deleteMessage = async ({ message, keyword, rest }) => {
  const trimmed = rest.trim();
  const targetId = trimmed.split(/\s+/)[0] || '';
  if (!targetId) {
    await sendReply(message, getResponse('deleteUsage'), { ephemeral: true });
    logCommandRun(message, 'delete', keyword);
    return;
  }
  let targetMsg = null;
  try {
    targetMsg = await message.channel?.messages?.fetch(targetId);
  } catch (_) {
    // ignore fetch failure
  }
  if (!targetMsg) {
    await sendReply(message, getResponse('deleteNotFound'), { ephemeral: true });
    logCommandRun(message, 'delete', keyword);
    return;
  }
  try {
    await targetMsg.delete();
    await sendReply(message, getResponse('deleteSuccess'), { ephemeral: true });
  } catch (err) {
    console.warn('delete failed:', err?.message || err);
    await sendReply(message, getResponse('deleteFail'), { ephemeral: true });
  }
  logCommandRun(message, 'delete', keyword);
};

actionHandlers.purge = async ({ message, keyword, rest }) => {
  const tokens = (rest || '').trim().split(/\s+/).filter(Boolean);
  const channelToken = tokens[0] || '';
  const countToken = /^\d{15,}$/.test(channelToken) ? tokens[1] : channelToken;
  let targetChannel = message.channel;
  let limit = 50;
  let deleteAll = false;
  if (countToken) {
    const lowered = countToken.toLowerCase();
    if (lowered === 'all') {
      deleteAll = true;
    } else if (/^\d+$/.test(lowered)) {
      limit = Math.max(1, Number(lowered));
    } else {
      await sendReply(message, 'usage: ?purge [channelId] [count|all]', { ephemeral: true });
      logCommandRun(message, 'purge', keyword);
      return;
    }
  }
  if (!deleteAll && /^\d{15,}$/.test(channelToken)) {
    try {
      const fetched = await message.client.channels.fetch(channelToken);
      if (fetched?.messages?.fetch) {
        targetChannel = fetched;
      } else {
        await sendReply(message, 'Could not access that channel.', { ephemeral: true });
        logCommandRun(message, 'purge', keyword);
        return;
      }
    } catch (err) {
      console.warn('purge failed to fetch channel:', err?.message || err);
      await sendReply(message, 'Could not access that channel.', { ephemeral: true });
      logCommandRun(message, 'purge', keyword);
      return;
    }
  }
  if (!targetChannel?.messages?.fetch) {
    await sendReply(message, 'No message history available in that channel.', { ephemeral: true });
    logCommandRun(message, 'purge', keyword);
    return;
  }
  const botId = client.user?.id;
  if (!botId) {
    await sendReply(message, 'Bot is not ready yet.', { ephemeral: true });
    logCommandRun(message, 'purge', keyword);
    return;
  }
  let deleted = 0;
  let beforeId = null;
  const targetCount = deleteAll ? Number.POSITIVE_INFINITY : limit;
  while (deleted < targetCount) {
    const options = { limit: 100 };
    if (beforeId) options.before = beforeId;
    let batch;
    try {
      batch = await targetChannel.messages.fetch(options);
    } catch (err) {
      console.warn('purge failed to fetch messages:', err?.message || err);
      break;
    }
    if (!batch.size) break;
    for (const msg of batch.values()) {
      if (msg.author?.id !== botId) continue;
      try {
        await msg.delete();
        deleted += 1;
      } catch (err) {
        console.warn('purge failed to delete message:', err?.message || err);
      }
      if (deleted >= targetCount) break;
    }
    beforeId = batch.last()?.id;
    if (!beforeId) break;
  }
  await sendReply(message, `Deleted ${deleted} bot message${deleted === 1 ? '' : 's'}.`, { ephemeral: true });
  logCommandRun(message, 'purge', keyword, deleteAll ? 'all' : String(limit));
};

actionHandlers.mentionBlock = async ({ message, keyword }) => {
  await sendReply(message, renderMentionBlock());
  logCommandRun(message, 'mentions', keyword);
};

actionHandlers.remind = async ({ message, rest, keyword }) => {
  const args = rest.trim();
  const [targetToken, ...msgParts] = args.split(/\s+/);
  const reminder = msgParts.join(' ').trim();
  if (!targetToken || !reminder) {
    await sendReply(message, getResponse('remindUsage'));
    logCommandRun(message, 'remind', keyword);
    return;
  }
  const target = await resolveUserTarget(message, targetToken);
  if (!target?.id) {
    await sendReply(message, getResponse('noId'));
    logCommandRun(message, 'remind', keyword);
    return;
  }
  let targetUser = null;
  try {
    targetUser = await client.users.fetch(target.id);
  } catch (err) {
    console.warn('failed to fetch target user:', err?.message || err);
  }
  const targetName = escapeUnderscores(
    targetUser?.username || targetToken || target.mention || `user ${target.id}`
  );
  if (!isRemindEnabled(target.id)) {
    await sendReply(message, getResponse('remindTargetDisabled', { target: targetName }));
    logCommandRun(message, 'remind', keyword);
    return;
  }
  const senderName = escapeUnderscores(message.author?.username || 'Someone');
  const entry = {
    body: getResponse('reminderBody', { sender: senderName, message: reminder }),
    fromId: message.author?.id || '',
    fromName: senderName,
    createdAt: Date.now()
  };
  enqueueReminder(target.id, entry);
  await sendReply(message, getResponse('remindSent', { target: targetName }));
  logCommandRun(message, 'remind', keyword);
};

actionHandlers.remindme = async ({ message, rest, keyword }) => {
  const toggle = rest.trim().toLowerCase();
  const userId = message.author?.id;
  if (!toggle || !userId || !['on', 'off'].includes(toggle)) {
    await sendReply(message, getResponse('remindmeUsage'));
    logCommandRun(message, 'remindme', keyword);
    return;
  }
  const wasEnabled = isRemindEnabled(userId);
  if (toggle === 'on') {
    if (!wasEnabled) saveRemindPrefs(userId, true);
    await sendReply(message, getResponse('remindToggleOn'));
    await deliverPendingReminders(message);
  } else {
    if (wasEnabled) saveRemindPrefs(userId, false);
    await sendReply(message, getResponse('remindToggleOff'));
  }
  logCommandRun(message, 'remindme', keyword);
};

actionHandlers.time = async ({ message, rest, keyword }) => {
  const authorId = message.author?.id;
  if (!authorId) {
    await sendReply(message, getResponse('noId'));
    logCommandRun(message, 'time', keyword);
    return;
  }
  timePrefs = loadTimePrefs();
  const rawArgs = rest.trim();
  if (!rawArgs) {
    const entries = Object.entries(timePrefs || {});
    if (!entries.length) {
      await sendReply(message, getResponse('timeListEmpty'));
      logCommandRun(message, 'time', `${keyword} list`);
      return;
    }
    const lines = [];
    for (const [userId, entry] of entries) {
      const formatted = formatTimeEntry(entry);
      if (!formatted) continue;
      const name = `<@${userId}>`;
      const time12 = formatted.time12 || formatted.time;
      lines.push(`- ${name}: ${formatted.time} (${time12})`);
    }
    if (!lines.length) {
      await sendReply(message, getResponse('timeListEmpty'));
    } else {
      await sendReply(message, [getResponse('timeListHeader'), ...lines].join('\n'));
    }
    logCommandRun(message, 'time', `${keyword} list`);
    return;
  }
  const [actionRaw, ...restParts] = rawArgs.split(/\s+/);
  const action = (actionRaw || '').toLowerCase();
  const payload = restParts.join(' ').trim();
  const saveEntry = async (input, mode) => {
    const parsed = parseTimeInput(input);
    if (!parsed) {
      await sendReply(message, getResponse('timeInvalid'));
      logCommandRun(message, 'time', `${keyword} ${mode}`);
      return;
    }
    if (parsed.type !== 'timezone') {
      await sendReply(message, getResponse('timeInvalid'));
      logCommandRun(message, 'time', `${keyword} ${mode}`);
      return;
    }
    const entry = { type: 'timezone', timeZone: parsed.timeZone, raw: parsed.raw, setAt: Date.now() };
    const nextPrefs = { ...timePrefs, [authorId]: entry };
    saveTimePrefs(nextPrefs);
    const formatted = formatTimeEntry(entry);
    const label = entry.timeZone;
    await sendReply(
      message,
      getResponse('timeSaved', {
        label,
        time: formatted?.time || 'n/a',
        time12: formatted?.time12 || 'n/a'
      })
    );
    logCommandRun(message, 'time', `${keyword} ${mode}`);
  };
  if (action === 'add') {
    if (!payload) {
      await sendReply(message, getResponse('timeUsage'));
      logCommandRun(message, 'time', `${keyword} add`);
      return;
    }
    await saveEntry(payload, 'add');
    return;
  }
  if (action === 'edit') {
    if (!getUserTimePref(authorId)) {
      await sendReply(message, getResponse('timeNotSet', { target: 'you' }));
      logCommandRun(message, 'time', `${keyword} edit`);
      return;
    }
    if (!payload) {
      await sendReply(message, getResponse('timeUsage'));
      logCommandRun(message, 'time', `${keyword} edit`);
      return;
    }
    await saveEntry(payload, 'edit');
    return;
  }
  if (action === 'remove') {
    if (getUserTimePref(authorId)) {
      const nextPrefs = { ...timePrefs };
      delete nextPrefs[authorId];
      saveTimePrefs(nextPrefs);
    }
    await sendReply(message, getResponse('timeRemoved'));
    logCommandRun(message, 'time', `${keyword} remove`);
    return;
  }
  const targetToken = rawArgs;
  const target = await resolveUserTarget(message, targetToken);
  if (!target?.id) {
    await sendReply(message, getResponse('noId'));
    logCommandRun(message, 'time', keyword);
    return;
  }
  const pref = getUserTimePref(target.id);
  const targetLabel = target.mention || `<@${target.id}>` || escapeUnderscores(targetToken || 'them');
  if (!pref) {
    await sendReply(message, getResponse('timeNotSet', { target: targetLabel }));
    logCommandRun(message, 'time', keyword);
    return;
  }
  const formatted = formatTimeEntry(pref);
  if (!formatted) {
    await sendReply(message, getResponse('timeInvalid'));
    logCommandRun(message, 'time', keyword);
    return;
  }
  const time12 = formatted.time12 || formatted.time;
  await sendReply(
    message,
    getResponse('timeResult', {
      target: targetLabel,
      time: formatted.time,
      time12
    })
  );
  logCommandRun(message, 'time', keyword);
};

actionHandlers.stats = async ({ message, keyword }) => {
  await sendReply(message, renderStats());
  logCommandRun(message, 'stats', keyword);
};

actionHandlers.join = async ({ message, keyword }) => {
  const userId = message.author?.id;
  if (!userId) return;
  const selfMention = `<@${userId}>`;
  if (mentionList.includes(selfMention)) {
    await sendReply(message, getResponse('joinAlready', { target: selfMention }));
  } else {
    mentionList.push(selfMention);
    mentionList = dedupe(mentionList);
    syncMaxUsers();
    saveMentionList();
    await sendReply(message, getResponse('joinAdded', { target: selfMention }));
  }
  logCommandRun(message, 'join', keyword);
};

actionHandlers.leave = async ({ message, keyword }) => {
  const userId = message.author?.id;
  if (!userId) return;
  const selfMention = `<@${userId}>`;
  const before = mentionList.length;
  mentionList = mentionList.filter((item) => item !== selfMention);
  if (mentionList.length === before) {
    await sendReply(message, getResponse('joinNotInList', { target: selfMention }));
  } else {
    saveMentionList();
    await sendReply(message, getResponse('joinRemoved', { target: selfMention }));
  }
  logCommandRun(message, 'leave', keyword);
};

actionHandlers.toggleSelfRole = async ({ message, keyword, def }) => {
  const roleKey = String(def?.id || keyword || '')
    .replace(/^\?/, '')
    .trim()
    .toLowerCase();
  const config = SELF_TOGGLE_ROLE_CONFIG[roleKey];
  if (!config) {
    await sendReply(message, 'Unknown self-role command.', { ephemeral: true });
    return;
  }

  const guild = message.guild || null;
  if (!guild) {
    await sendReply(message, 'This command must be used in a server.', { ephemeral: true });
    logCommandRun(message, roleKey, keyword);
    return;
  }

  let member = message.member || guild.members?.cache?.get(message.author?.id || '') || null;
  if (!member && message.author?.id && guild.members?.fetch) {
    try {
      member = await guild.members.fetch(message.author.id);
    } catch (err) {
      console.warn(`failed to fetch member:`, err?.message || err);
    }
  }
  if (!member) {
    await sendReply(message, 'Could not find you in this server? please ping mcfe');
    logCommandRun(message, roleKey, keyword);
    return;
  }

  const role = await resolveSelfToggleRole(guild, roleKey);
  if (!role) {
    await sendReply(message, `Could not find ${roleKey} role`);
    logCommandRun(message, roleKey, keyword);
    return;
  }

  const hasRole = member.roles?.cache?.has(role.id);
  try {
    if (hasRole) {
      await member.roles.remove(role, `${roleKey} command by ${message.author?.id || 'unknown'}`);
    } else {
      await member.roles.add(role, `${roleKey} command by ${message.author?.id || 'unknown'}`);
    }
  } catch (err) {
    console.warn(`failed to toggle ${roleKey} role:`, err?.message || err);
    await sendReply(message, `Failed to give/remove the ${roleKey} role.`);
    logCommandRun(message, roleKey, keyword, 'failed');
    return;
  }

  await sendReply(
    message,
    `${hasRole ? 'Removed' : 'Added'} ${role.toString()} ${hasRole ? 'from' : 'to'} you. run the command again to toggle it back.`);
  logCommandRun(message, roleKey, keyword, hasRole ? 'off' : 'on');
};

actionHandlers.frickyou = async ({ message, keyword, def }) => {
  await sendReply(message, getResponse(def?.responseKey || 'frickyou'));
  logCommandRun(message, 'frickyou', keyword);
};

actionHandlers.jay = async ({ message, keyword }) => {
  const line = pickRandom(JAY_LINES);
  if (!line) return;
  await sendMessage(message, line);
  logCommandRun(message, 'jay', keyword);
};

actionHandlers.メクッフィー = async ({ message, keyword, def }) => {
  await sendReply(message, getResponse(def?.responseKey || 'mcfePing'));
  logCommandRun(message, 'メクッフィー', keyword);
};

actionHandlers.send = async ({ message, def, keyword }) =>
  actionHandlers.simpleResponse({ message, def, keyword, reply: false });

actionHandlers.reply = async ({ message, def, keyword }) =>
  actionHandlers.simpleResponse({ message, def, keyword, reply: true });

actionHandlers.remindRemove = async ({ message, keyword, rest }) => {
  const token = (rest || '').split(/\s+/)[0] || '';
  const target = await resolveUserTarget(message, token);
  if (!target) return sendReply(message, getResponse('noId'));
  if (!isRemindEnabled(target.id)) {
    await sendReply(message, getResponse('remindRemoveMissing', { target: target.mention }));
    return;
  }
  saveRemindPrefs(target.id, false);
  await sendReply(message, getResponse('remindRemoveDone', { target: target.mention }));
  logCommandRun(message, 'remindremove', keyword);
};

actionHandlers.add = async ({ message, keyword, rest, isOwner, isWhitelisted }) => {
  const parts = (rest || '').trim().split(/\s+/);
  const targetList = (parts.shift() || '').toLowerCase();
  const userToken = parts.join(' ').trim();
  if (!targetList || !userToken) {
    await sendReply(message, getResponse('addUsage'), { ephemeral: true });
    return;
  }
  const target = await resolveUserTarget(message, userToken);
  if (!target) {
    await sendReply(message, getResponse('noId'), { ephemeral: true });
    return;
  }
  const forMentions = ['mention', 'mentions', 'list'].includes(targetList);
  const forWhitelist = ['whitelist', 'wl'].includes(targetList);
  const forReminders = ['reminders', 'reminder', 'remind'].includes(targetList);

  if (forMentions) {
    if (!isWhitelisted && !isOwner) {
      await sendReply(message, getResponse('notAllowed'), { ephemeral: true });
      return;
    }
    if (mentionList.includes(target.mention)) {
      await sendReply(message, getResponse('alreadyInList', { target: target.mention }), { ephemeral: true });
      return;
    }
    mentionList.push(target.mention);
    mentionList = dedupe(mentionList);
    syncMaxUsers();
    saveMentionList();
    await sendReply(message, getResponse('addedMention', { target: target.mention }), { ephemeral: true });
    logCommandRun(message, 'add', `${keyword} mentions`);
    return;
  }

  if (forWhitelist) {
    if (!isOwner) {
      await sendReply(message, getResponse('notAllowed'), { ephemeral: true });
      return;
    }
    if (whitelistUserIds.includes(target.id)) {
      await sendReply(message, getResponse('alreadyWhitelisted', { target: target.mention }), { ephemeral: true });
      return;
    }
    saveWhitelist(whitelistUserIds.concat([target.id]));
    await sendReply(message, getResponse('addedWhitelist', { target: target.mention }), { ephemeral: true });
    logCommandRun(message, 'add', `${keyword} whitelist`);
    return;
  }

  if (forReminders) {
    if (!isOwner) {
      await sendReply(message, getResponse('notAllowed'), { ephemeral: true });
      return;
    }
    if (isRemindEnabled(target.id)) {
      await sendReply(message, getResponse('remindAddExists', { target: target.mention }), { ephemeral: true });
      return;
    }
    saveRemindPrefs(target.id, true);
    await sendReply(message, getResponse('remindAddAdded', { target: target.mention }), { ephemeral: true });
    logCommandRun(message, 'add', `${keyword} reminders`);
    return;
  }

  await sendReply(message, getResponse('addUsage'), { ephemeral: true });
};

actionHandlers.mentionRemove = async ({ message, keyword }) => {
  await handleRemove(message);
  logCommandRun(message, 'remove', keyword);
};

actionHandlers.powerup = async ({ message, rest, keyword }) => {
  const content = renderMentionList(rest);
  await sendMessage(message, content);
  logCommandRun(message, 'powerup', keyword);
};

actionHandlers.messageControl = async ({ message, rest, keyword }) => {
  const parts = (rest || '').trim().length ? (rest || '').trim().split(/\s+/) : [];
  const action = (parts[0] || 'display').toLowerCase();
  const payload = parts.slice(1).join(' ').trim();
  if (action === 'edit') {
    if (!payload) return sendReply(message, getResponse('noMessageProvided'));
    saveMessageText(payload);
    await sendReply(message, getResponse('messageUpdated'));
    logCommandRun(message, 'message', `${keyword} edit`);
    return;
  }
  if (action === 'remove') {
    saveMessageText('');
    await sendReply(message, getResponse('messageCleared'));
    logCommandRun(message, 'message', `${keyword} remove`);
    return;
  }
  if (action === 'display') {
    await sendReply(message, savedMessage || getResponse('noMessageSet'));
    logCommandRun(message, 'message', `${keyword} display`);
    return;
  }
  await sendReply(message, getResponse('unknownAction'));
};

actionHandlers.whitelist = async ({ message, rest, keyword, isOwner }) => {
  if (!isOwner) return sendReply(message, getResponse('notAllowed'));
  const [actionRaw, ...restParts] = rest.split(/\s+/);
  const action = (actionRaw || 'display').toLowerCase();
  if (action === 'add') {
    const token = restParts.join(' ').trim();
    const target = await resolveUserTarget(message, token);
    if (!target) return sendReply(message, getResponse('noId'));
    if (whitelistUserIds.includes(target.id)) {
      await sendReply(message, getResponse('alreadyWhitelisted', { target: target.mention }));
      return;
    }
    whitelistUserIds.push(target.id);
    whitelistUserIds = dedupe(whitelistUserIds);
    saveWhitelist();
    await sendReply(message, getResponse('addedWhitelist', { target: target.mention }));
    logCommandRun(message, 'whitelist', `${keyword} add`);
    return;
  }
  if (action === 'remove') {
    const token = restParts.join(' ').trim();
    const target = await resolveUserTarget(message, token);
    if (!target) return sendReply(message, getResponse('noId'));
    const before = whitelistUserIds.length;
    whitelistUserIds = whitelistUserIds.filter((id) => id !== target.id);
    if (whitelistUserIds.length === before) {
      await sendReply(message, getResponse('whitelistRemoveMissing', { target: target.mention }));
      return;
    }
    saveWhitelist();
    await sendReply(message, getResponse('whitelistRemoveDone', { target: target.mention }));
    logCommandRun(message, 'whitelist', `${keyword} remove`);
    return;
  }
  const body = whitelistUserIds.length
    ? whitelistUserIds.map((id) => `<@${id}>`).join(' ')
    : getResponse('whitelistedEmpty');
  await sendReply(message, getResponse('whitelistedList', { list: body }));
  logCommandRun(message, 'whitelist', `${keyword} display`);
};

actionHandlers.restart = async ({ message, keyword, isOwner }) => {
  if (!isOwner) return sendReply(message, getResponse('notAllowed'));
  persistVoiceSessionsIfAny();
  logCommandRun(message, 'restart', keyword);
  await sendReply(message, getResponse('restarting'));
  restartBot();
};

actionHandlers.siteBlock = async ({ message, keyword, rest, isOwner }) => {
  if (!isOwner) {
    await sendReply(message, getResponse('notAllowed'));
    return;
  }
  const targets = resolveSiteBlockTargets(rest);
  if (!targets) {
    await sendReply(message, `usage: ${keyword} <url|twitter>`, { ephemeral: true });
    return;
  }
  try {
    const detail = await runSiteBlockAction('block', targets.urls);
    await sendReply(message, `blocked`);
  } catch (err) {
    console.warn(`[block] failed for ${targets.label}:`, err?.message || err);
    await sendReply(message, `block failed`);
  } finally {
    logCommandRun(message, 'block', `${keyword} ${targets.label}`);
  }
};

actionHandlers.siteUnblock = async ({ message, keyword, rest, isOwner }) => {
  if (!isOwner) {
    await sendReply(message, getResponse('notAllowed'));
    return;
  }
  const targets = resolveSiteBlockTargets(rest);
  if (!targets) {
    await sendReply(message, `usage: ${keyword} <url|twitter>`, { ephemeral: true });
    return;
  }
  try {
    const detail = await runSiteBlockAction('unblock', targets.urls);
    await sendReply(message, `unblocked`);
  } catch (err) {
    console.warn(`[unblock] failed for ${targets.label}:`, err?.message || err);
    await sendReply(message, `unblock failed`);
  } finally {
    logCommandRun(message, 'unblock', `${keyword} ${targets.label}`);
  }
};

actionHandlers.timeout = async ({ message, rest, keyword }) => {
  const usageText = 'usage: ?timeout <user> [seconds]';
  const rawInput = String(rest || '').trim();
  if (!rawInput) {
    await sendReply(message, usageText, { ephemeral: true });
    return;
  }
  const parts = rawInput.split(/\s+/).filter(Boolean);
  let token = rawInput;
  let durationSeconds = null;
  const durationToken = parts.length > 1 ? parts[parts.length - 1] : '';
  if (/^\d+$/.test(durationToken)) {
    const parsed = Number(durationToken);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      await sendReply(message, usageText, { ephemeral: true });
      return;
    }
    durationSeconds = Math.floor(parsed);
    token = parts.slice(0, -1).join(' ').trim();
    if (!token) {
      await sendReply(message, usageText, { ephemeral: true });
      return;
    }
    const delayMs = durationSeconds * 1000;
    if (delayMs > 2_147_483_647) {
      await sendReply(message, 'Timeout duration over int limit', {
        ephemeral: true
      });
      return;
    }
  }
  const guild = message.guild;
  if (!guild) {
    await sendReply(message, 'This command must be used in a server.', { ephemeral: true });
    return;
  }
  const target = await resolveUserTarget(message, token);
  const fallbackTarget =
    !target && durationSeconds !== null && token !== rawInput
      ? await resolveUserTarget(message, rawInput)
      : null;
  const resolvedTarget = target || fallbackTarget;
  if (!resolvedTarget) {
    await sendReply(message, getResponse('noId'), { ephemeral: true });
    return;
  }
  if (fallbackTarget) {
    durationSeconds = null;
  }
  let member = guild.members.cache.get(resolvedTarget.id) || null;
  if (!member && guild.members.fetch) {
    try {
      member = await guild.members.fetch(resolvedTarget.id);
    } catch (err) {
      console.warn('failed to fetch timeout target:', err?.message || err);
    }
  }
  if (!member) {
    await sendReply(message, 'User not found in this server.', { ephemeral: true });
    return;
  }
  let role = guild.roles.cache.get(TIMEOUT_ROLE_ID) || null;
  if (!role && guild.roles.fetch) {
    try {
      role = await guild.roles.fetch(TIMEOUT_ROLE_ID);
    } catch (err) {
      console.warn('failed to fetch timeout role:', err?.message || err);
    }
  }
  if (!role) {
    await sendReply(message, 'Timeout role not found.', { ephemeral: true });
    return;
  }
  const alreadyHasRole = member.roles?.cache?.has(TIMEOUT_ROLE_ID);
  if (!alreadyHasRole) {
    try {
      await member.roles.add(role, `timeout command by ${message.author?.id || 'unknown'}`);
    } catch (err) {
      console.warn('failed to add timeout role:', err?.message || err);
      await sendReply(message, 'Failed to add the timeout role.', { ephemeral: true });
      return;
    }
  }
  if (durationSeconds) {
    const delayMs = durationSeconds * 1000;
    setTimeout(async () => {
      let freshMember = guild.members.cache.get(resolvedTarget.id) || null;
      if (!freshMember && guild.members.fetch) {
        try {
          freshMember = await guild.members.fetch(resolvedTarget.id);
        } catch (err) {
          console.warn('failed to fetch timeout target for removal:', err?.message || err);
          return;
        }
      }
      if (!freshMember?.roles?.cache?.has(TIMEOUT_ROLE_ID)) return;
      try {
        await freshMember.roles.remove(
          TIMEOUT_ROLE_ID,
          `timeout expired after ${durationSeconds}s`
        );
      } catch (err) {
        console.warn('failed to remove timeout role:', err?.message || err);
      }
    }, delayMs);
  }
  if (alreadyHasRole && !durationSeconds) {
    await sendReply(message, `${resolvedTarget.mention} already has the timeout role.`, {
      ephemeral: true
    });
    return;
  }
  if (durationSeconds) {
    await sendReply(
      message,
      `${alreadyHasRole ? 'Already in timeout; ' : ''}expires in ${
        durationSeconds
      }s for ${resolvedTarget.mention}.`,
      { ephemeral: true }
    );
  } else {
    await sendReply(message, `Added timeout role to ${resolvedTarget.mention}.`, { ephemeral: true });
  }
  logCommandRun(message, 'timeout', keyword, durationSeconds ? `${durationSeconds}s` : undefined);
};

actionHandlers.joinVoice = async ({ message, keyword }) => {
  const state = await getOrCreateVoice(message);
  if (!state) {
    await sendReply(message, 'Could not find a voice channel to join.', { ephemeral: true });
    return;
  }
  await sendReply(message, 'Joined voice.');
  logCommandRun(message, 'joinvoice', keyword);
};

actionHandlers.leaveVoice = async ({ message, keyword }) => {
  const guildId = message.guild?.id || message.guildId || null;
  if (!guildId) {
    await sendReply(message, 'No guild to leave.', { ephemeral: true });
    return;
  }
  const before = getVoiceConnection(guildId);
  leaveVoice(guildId);
  const after = getVoiceConnection(guildId);
  if (before || after) {
    await sendReply(message, 'Left voice.', { ephemeral: true });
  } else {
    await sendReply(message, 'Not connected to a voice channel.', { ephemeral: true });
  }
  logCommandRun(message, 'leavevoice', keyword);
};

actionHandlers.stopTts = async ({ message, keyword }) => {
  const state = getActiveVoiceState(message);
  if (!state?.player) {
    await sendReply(message, 'No tts active.');
    return;
  }
  stopPlayback(state);
  logCommandRun(message, 'stoptts', keyword);
};

actionHandlers.pauseTts = async ({ message, keyword }) => {
  const state = getActiveVoiceState(message);
  if (!state?.player) {
    await sendReply(message, 'No tts active.');
    return;
  }
  const paused = pausePlayback(state);
  if (!paused) {
    await sendReply(message, 'No tts active.');
    return;
  }
  logCommandRun(message, 'pausetts', keyword);
};

actionHandlers.resumeTts = async ({ message, keyword }) => {
  const state = getActiveVoiceState(message);
  if (!state?.player) {
    await sendReply(message, 'No tts paused.');
    return;
  }
  const resumed = resumePlayback(state);
  if (!resumed) {
    await sendReply(message, 'No tts paused.');
    return;
  }
  logCommandRun(message, 'resumetts', keyword);
};

actionHandlers.status = async ({ message, rest, keyword }) => {
  const statusText = rest.trim();
  if (!statusText) {
    await sendReply(message, 'usage: status <message>');
    return;
  }
  const guildId = message.guild?.id;
  if (!guildId) return;
  const state = getActiveVoiceState(message);
  const connection = state?.connection || getVoiceConnection(guildId);
  const channelId = connection?.joinConfig?.channelId || null;
  if (!channelId) {
    await sendReply(message, 'rerun ?joinvc');
    return;
  }
  const statusLabel = statusText.slice(0, 100);
  const url = `https://discord.com/api/v10/channels/${channelId}/voice-status`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: statusLabel })
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body || 'no body'}`);
    }
  } catch (err) {
    console.warn('failed to set voice status:', err?.message || err);
    await sendReply(message, 'Could not update the voice channel status.');
    return;
  }
  logCommandRun(message, 'status', keyword);
};

actionHandlers.convert = async ({ message, keyword, rest }) => {
  const parsed = parseConvertArguments(rest);
  if (!parsed) {
    await sendReply(
      message,
      `usage: ${keyword} <amount> <from> <to>\nexamples: ${keyword} 180 cm ft | ${keyword} 72f c`
    );
    logCommandRun(message, 'convert', keyword);
    return;
  }
  const result = convertUnits(parsed.amount, parsed.fromUnit, parsed.toUnit);
  await sendReply(message, result.ok ? `Conversion: ${result.text}` : result.error || 'Unsupported conversion.');
  logCommandRun(message, 'convert', keyword);
};

actionHandlers.clearTtsCache = async ({ message, keyword, isOwner }) => {
  if (!isOwner) {
    await sendReply(message, getResponse('notAllowed'));
    return;
  }
  const cacheDir = path.join(__dirname, 'tts-cache');
  try {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    await sendReply(message, 'TTS cache cleared.');
  } catch (err) {
    console.warn('failed to clear tts cache:', err?.message || err);
    await sendReply(message, 'Failed to clear TTS cache.');
  }
  logCommandRun(message, 'clearttscache', keyword);
};

actionHandlers.replyToMessage = async ({ message, rest, keyword }) => {
  const parts = rest.trim().split(/\s+/);
  const targetId = parts.shift();
  const body = parts.join(' ').trim();
  if (!targetId || !body) {
    await sendReply(message, 'usage: reply <messageId> <message>', { ephemeral: true });
    return;
  }
  let targetMsg = null;
  const searchChannels = [];
  const currentId = message.channelId || message.channel?.id;
  if (currentId) searchChannels.push(currentId);
  const refChannelId = message.reference?.channelId;
  if (refChannelId && !searchChannels.includes(refChannelId)) searchChannels.push(refChannelId);
  if (allowedChannels.size) {
    for (const id of allowedChannels) {
      if (!searchChannels.includes(id)) searchChannels.push(id);
    }
  }
  if (message.guild) {
    message.guild.channels.cache.forEach((ch) => {
      if (ch?.messages && !searchChannels.includes(ch.id)) {
        searchChannels.push(ch.id);
      }
    });
  }
  for (const channelId of searchChannels) {
    try {
      const channel =
        message.client.channels.cache.get(channelId) ||
        (await message.client.channels.fetch(channelId));
      if (!channel?.messages?.fetch) continue;
      const fetched = await channel.messages.fetch(targetId);
      if (fetched) {
        targetMsg = fetched;
        break;
      }
    } catch (err) {
      // ignore per-channel fetch errors
    }
  }
  if (!targetMsg) {
    await sendReply(message, 'message not found', { ephemeral: true });
    return;
  }
  try {
    await targetMsg.reply({ content: body });
    await sendReply(message, 'sent reply.', { ephemeral: true });
    logCommandRun(message, 'replyToMessage', keyword);
  } catch (err) {
    console.warn('failed to reply to message:', err?.message || err);
    await sendReply(message, 'could not reply to that message', { ephemeral: true });
  }
};

actionHandlers.tts = async ({ message, keyword }) => {
  const channelId = message.channelId || message.channel?.id || null;
  if (!channelId) {
    await sendReply(message, 'No channel available for toggling TTS.');
    logCommandRun(message, 'tts', keyword);
    return;
  }
  const enabled = toggleTtsEnabled(channelId);
  await sendReply(message, `TTS is now ${enabled ? 'enabled' : 'disabled'}.`);
  logCommandRun(message, 'tts', keyword);
};

const hasCommandAccess = (def, { isOwner, isWhitelisted, authorId }) => {
  const access = def?.access || 'any';
  if (access === 'owner') return isOwner;
  if (access === 'whitelist') return isOwner || isWhitelisted;
  if (access === 'couple') return coupleUserIds.has(authorId);
  return true;
};

const normalizeConvertUnit = (raw) => {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\u00b2/g, '2')
    .replace(/[^a-z0-9]/g, '');
  const map = {
    c: 'c',
    cel: 'c',
    cels: 'c',
    celcius: 'c',
    celsius: 'c',
    f: 'f',
    fah: 'f',
    fahrenheit: 'f',
    cm: 'cm',
    cms: 'cm',
    centimeter: 'cm',
    centimeters: 'cm',
    centimetre: 'cm',
    centimetres: 'cm',
    in: 'in',
    inch: 'in',
    inches: 'in',
    ft: 'ft',
    foot: 'ft',
    feet: 'ft',
    m: 'm',
    meter: 'm',
    metres: 'm',
    meters: 'm',
    metre: 'm',
    kg: 'kg',
    kilogram: 'kg',
    kilograms: 'kg',
    lb: 'lb',
    lbs: 'lb',
    pound: 'lb',
    pounds: 'lb',
    mph: 'mph',
    miph: 'mph',
    kmh: 'kph',
    kph: 'kph',
    kmph: 'kph',
    ms: 'm',
    // area
    ft2: 'ft2',
    ft2sq: 'ft2',
    ft2sqft: 'ft2',
    sqft: 'ft2',
    m2: 'm2',
    sqm: 'm2'
  };
  return map[value] || null;
};

const parseConvertArguments = (raw) => {
  const tokens = String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;
  const compact = tokens[0].match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z0-9\u00b2]+)$/i);
  if (compact && tokens[1]) {
    return {
      amount: Number(compact[1]),
      fromUnit: compact[2],
      toUnit: tokens[1]
    };
  }
  if (tokens.length < 3) return null;
  const amount = Number(tokens[0]);
  if (!Number.isFinite(amount)) return null;
  return {
    amount,
    fromUnit: tokens[1],
    toUnit: tokens[2]
  };
};

const formatFeetInches = (inches) => {
  const feet = Math.floor(inches / 12);
  const remInches = inches - feet * 12;
  return `${feet} ft ${remInches.toFixed(2)} in`;
};

const convertUnits = (amount, fromUnit, toUnit) => {
  const from = normalizeConvertUnit(fromUnit);
  const to = normalizeConvertUnit(toUnit);
  if (!from || !to) {
    return { ok: false, error: `Use units: ${SUPPORTED_CONVERT_UNITS.join(', ')}.` };
  }
  const labels = {
    c: '°C',
    f: '°F',
    cm: 'cm',
    in: 'in',
    ft: 'ft',
    m: 'm',
    kg: 'kg',
    lb: 'lbs',
    mph: 'mph',
    kph: 'kph',
    ft2: 'ft²',
    m2: 'm²'
  };
  if (from === to) {
    return { ok: true, text: `${amount} ${labels[from]} = ${amount} ${labels[to]}` };
  }
  switch (from) {
    case 'c':
      if (to === 'f') return { ok: true, text: `${amount} °C = ${(amount * 9 / 5 + 32).toFixed(2)} °F` };
      break;
    case 'f':
      if (to === 'c') return { ok: true, text: `${amount} °F = ${(((amount - 32) * 5) / 9).toFixed(2)} °C` };
      break;
    case 'kg':
      if (to === 'lb') return { ok: true, text: `${amount} kg = ${(amount / 0.45359237).toFixed(2)} lbs` };
      break;
    case 'lb':
      if (to === 'kg') return { ok: true, text: `${amount} lbs = ${(amount * 0.45359237).toFixed(2)} kg` };
      break;
    case 'mph':
      if (to === 'kph') return { ok: true, text: `${amount} mph = ${(amount * 1.60934).toFixed(2)} kph` };
      break;
    case 'kph':
      if (to === 'mph') return { ok: true, text: `${amount} kph = ${(amount / 1.60934).toFixed(2)} mph` };
      break;
    case 'cm': {
      const inches = amount / 2.54;
      if (to === 'in') return { ok: true, text: `${amount} cm = ${inches.toFixed(2)} in` };
      if (to === 'ft') {
        return { ok: true, text: `${amount} cm = ${formatFeetInches(inches)} (${inches.toFixed(2)} in)` };
      }
      break;
    }
    case 'in': {
      const cm = amount * 2.54;
      if (to === 'cm') return { ok: true, text: `${amount} in = ${cm.toFixed(2)} cm` };
      if (to === 'ft') return { ok: true, text: `${amount} in = ${formatFeetInches(amount)}` };
      break;
    }
    case 'ft': {
      const inches = amount * 12;
      if (to === 'in') return { ok: true, text: `${amount} ft = ${inches.toFixed(2)} in` };
      if (to === 'cm') return { ok: true, text: `${amount} ft = ${(inches * 2.54).toFixed(2)} cm (${inches.toFixed(2)} in)` };
      if (to === 'm') return { ok: true, text: `${amount} ft = ${(inches * 2.54 / 100).toFixed(3)} m` };
      break;
    }
    case 'm': {
      const cm = amount * 100;
      const inches = cm / 2.54;
      const feet = inches / 12;
      if (to === 'ft') return { ok: true, text: `${amount} m = ${feet.toFixed(3)} ft (${formatFeetInches(inches)})` };
      if (to === 'cm') return { ok: true, text: `${amount} m = ${cm.toFixed(2)} cm` };
      if (to === 'in') return { ok: true, text: `${amount} m = ${inches.toFixed(2)} in` };
      break;
    }
    case 'ft2': {
      const m2 = amount * 0.092903;
      if (to === 'm2') return { ok: true, text: `${amount} ft² = ${m2.toFixed(4)} m²` };
      break;
    }
    case 'm2': {
      const ft2 = amount / 0.092903;
      if (to === 'ft2') return { ok: true, text: `${amount} m² = ${ft2.toFixed(4)} ft²` };
      break;
    }
    default:
      break;
  }
  return {
    ok: false,
    error:
      'Unsupported conversion. Valid: C↔F, cm↔in|ft, in↔cm|ft, ft↔cm|in|m, m↔ft|cm|in, lbs↔kg, mph↔kph, ft²↔m².'
  };
};

async function runCommandById(commandId, ctx) {
  const def = ctx.def || commandDef(commandId);
  if (!def) return;
  const action = def.action || (def.response || def.responseKey ? 'reply' : null);
  const handler = actionHandlers[action];
  if (handler) {
    await handler({ ...ctx, def, action });
    return;
  }
  if (def.response || def.responseKey) {
    await actionHandlers.simpleResponse({ ...ctx, def, reply: true });
  }
}

async function handleCommand(message, { isOwner, isWhitelisted, authorId, channelId }) {
  const content = (message.content || '').trim();
  const lowerContent = content.toLowerCase();
  const alreadyRun = new Set();

  for (const id of matchAnywhereCommands) {
    const def = commandDef(id);
    const trig = def?.trigger?.toLowerCase();
    if (!trig) continue;
    const pattern = new RegExp(`${escapeRegex(trig)}\\b`, 'i');
    if (!pattern.test(content)) continue;
    if (!hasCommandAccess(def, { isOwner, isWhitelisted, authorId })) continue;
    await runCommandById(id, {
      message,
      keyword: def.trigger,
      def,
      rest: '',
      isOwner,
      isWhitelisted,
      channelId,
      authorId
    });
    alreadyRun.add(id);
  }

  if (!content.startsWith('?')) return;
  const keyword = content.split(/\s+/)[0].toLowerCase();
  const commandId = getCommandId(keyword);
  if (!commandId) return;
  const def = commandDef(commandId);
  if (!def) return;
  if (alreadyRun.has(commandId)) return;
  if (!hasCommandAccess(def, { isOwner, isWhitelisted, authorId })) {
    await sendReply(message, getResponse('notAllowed'));
    return;
  }
  const rest = content.slice(keyword.length).trim();
  await runCommandById(commandId, {
    message,
    keyword,
    def,
    rest,
    isOwner,
    isWhitelisted,
    channelId,
    authorId
  });
}

client.on(Events.MessageCreate, async (message) => {
  let stage = 'start';
  try {
    if (!message) return;
    stage = 'fetch_partial_message';
    if (message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        console.warn('failed to fetch partial message:', err?.message || err);
        return;
      }
    }
    stage = 'filter_message';
    if (message.author?.bot || ignoredBotIds.includes(message.author?.id)) return;
    const isDm = !message.guild;
    const guildId = message.guild?.id || message.guildId || null;
    const channelId = message.channelId || message.channel?.id || null;
    const userId = message.author?.id || '';
    const isOwner = userId === AUTHORIZED_USER_ID;
    const isWhitelisted = whitelistUserIds.includes(userId);
    const isAuthorizedUser = isOwner || isWhitelisted || allowedUsers.has(userId);

    stage = 'monitor_keyword_alerts';
    await monitorKeywordAlerts(message, { isDm, guildId, channelId });

    if (isDm) {
      stage = 'bump_message_count_dm';
      bumpMessageCount(message);
      stage = 'deliver_pending_reminders_dm';
      await deliverPendingReminders(message);
      stage = 'handle_command_dm';
      await handleCommand(message, { isOwner, isWhitelisted, authorId: userId, channelId });
      return;
    }

    stage = 'authorize_message';
    if (!isDm && !isAuthorizedUser) {
      const channelExplicitlyAllowed = allowedChannels.size > 0 && channelId && allowedChannels.has(channelId);
      if (allowedChannels.size > 0 && channelId && !channelExplicitlyAllowed) return;
      if (!channelExplicitlyAllowed && allowedGuilds.size && guildId && !allowedGuilds.has(guildId)) return;
    }

    stage = 'bump_message_count';
    bumpMessageCount(message);
    stage = 'deliver_pending_reminders';
    await deliverPendingReminders(message);
    stage = 'handle_auto_tts';
    await handleAutoTts(message);
    stage = 'handle_command';
    await handleCommand(message, { isOwner, isWhitelisted, authorId: userId, channelId });
  } catch (err) {
    const guildId = message?.guild?.id || message?.guildId || null;
    const channelId = message?.channelId || message?.channel?.id || null;
    const authorId = message?.author?.id || null;
    console.warn(
      `[messageCreate] handler failed stage=${stage} guild=${guildId || 'dm'} channel=${channelId || 'unknown'} author=${authorId || 'unknown'}:`,
      err?.message || err
    );
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);

