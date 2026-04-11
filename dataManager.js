const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');

const DEFAULT_BASE_DIR = path.join(__dirname, 'data');
const ENTITY_SUBDIRS = ['users', 'channels', 'servers'];
const ENTITY_DIRS = {
  user: 'users',
  users: 'users',
  channel: 'channels',
  channels: 'channels',
  server: 'servers',
  servers: 'servers'
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const sanitizeId = (id) => {
  const raw = String(id || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const ensureDir = (dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    console.warn(`failed to create dir ${dirPath}:`, err?.message || err);
  }
};

const ensureDataDirs = (baseDir = DEFAULT_BASE_DIR) => {
  ensureDir(baseDir);
  ENTITY_SUBDIRS.forEach((subdir) => ensureDir(path.join(baseDir, subdir)));
};

const resolveEntityPath = (type, id, baseDir = DEFAULT_BASE_DIR) => {
  const dirName = ENTITY_DIRS[type];
  if (!dirName) {
    throw new Error(`Unknown data type: ${type}`);
  }
  const safeId = sanitizeId(id);
  if (!safeId) {
    throw new Error('Missing id for data path');
  }
  return path.join(baseDir, dirName, `${safeId}.json`);
};

const readJsonFile = (filePath, { fallback = null } = {}) => {
  const candidates = [filePath, `${filePath}.bak`, `${filePath}.tmp`];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      if (!raw) continue;
      return JSON5.parse(raw);
    } catch (_) {
      // ignore and fall through
    }
  }
  return fallback;
};

const writeJsonAtomic = (filePath, data, { backup = true } = {}) => {
  const dirPath = path.dirname(filePath);
  ensureDir(dirPath);
  const tmpPath = `${filePath}.tmp`;
  try {
    const payload = JSON.stringify(data, null, 2);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeFileSync(fd, payload, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (backup && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      if (['EEXIST', 'EPERM', 'EACCES'].includes(err?.code)) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        fs.renameSync(tmpPath, filePath);
      } else {
        throw err;
      }
    }
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {
      // ignore cleanup failures
    }
    console.warn(`failed to write ${filePath}:`, err?.message || err);
    return false;
  }
};

const readEntityData = (type, id, { baseDir = DEFAULT_BASE_DIR, fallback = null } = {}) => {
  ensureDataDirs(baseDir);
  const filePath = resolveEntityPath(type, id, baseDir);
  return readJsonFile(filePath, { fallback });
};

const writeEntityData = (type, id, data, { baseDir = DEFAULT_BASE_DIR, backup = true } = {}) => {
  ensureDataDirs(baseDir);
  const filePath = resolveEntityPath(type, id, baseDir);
  return writeJsonAtomic(filePath, data, { backup });
};

const updateEntityData = (type, id, updater, { baseDir = DEFAULT_BASE_DIR, backup = true } = {}) => {
  if (typeof updater !== 'function') {
    throw new Error('updateEntityData expects an updater function');
  }
  const current = readEntityData(type, id, { baseDir, fallback: {} }) || {};
  const next = updater(isPlainObject(current) ? { ...current } : {});
  writeEntityData(type, id, next, { baseDir, backup });
  return next;
};

const readUserData = (userId, options = {}) => readEntityData('user', userId, options);
const writeUserData = (userId, data, options = {}) => writeEntityData('user', userId, data, options);
const updateUserData = (userId, updater, options = {}) => updateEntityData('user', userId, updater, options);

const readChannelData = (channelId, options = {}) => readEntityData('channel', channelId, options);
const writeChannelData = (channelId, data, options = {}) => writeEntityData('channel', channelId, data, options);
const updateChannelData = (channelId, updater, options = {}) => updateEntityData('channel', channelId, updater, options);

const readServerData = (serverId, options = {}) => readEntityData('server', serverId, options);
const writeServerData = (serverId, data, options = {}) => writeEntityData('server', serverId, data, options);
const updateServerData = (serverId, updater, options = {}) => updateEntityData('server', serverId, updater, options);

module.exports = {
  DEFAULT_BASE_DIR,
  ensureDataDirs,
  sanitizeId,
  resolveEntityPath,
  readJsonFile,
  writeJsonAtomic,
  readUserData,
  writeUserData,
  updateUserData,
  readChannelData,
  writeChannelData,
  updateChannelData,
  readServerData,
  writeServerData,
  updateServerData
};
