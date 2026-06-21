const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  DEFAULT_BASE_DIR,
  ensureDataDirs,
  readJsonFile,
  readChannelData,
  updateChannelData
} = require('./dataManager');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus
} = require('@discordjs/voice');

function createVoiceManager({
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
}) {
  const voiceStates = new Map(); // channelId -> { connection, player }
  const ttsAnnounceState = new Map(); // channelId -> { lastSpeakerId, lastSpokenAt }
  const VOICE_RECONNECT_BASE_DELAY_MS = 2000;
  const VOICE_RECONNECT_MAX_DELAY_MS = 30000;
  const VOICE_RECONNECT_MAX_ATTEMPTS = 10;
  const VOICE_DISCONNECT_GRACE_MS = 30000;
  const PLAYBACK_RATE = 1.2;

  let legacyChannelDataHandled = false;
  let legacyTtsDefault = true;
  const legacyTtsToggleFile = path.join(__dirname, 'ttsEnabled.json');
  const legacyVoiceSessionFile = path.join(__dirname, 'voiceSession.json');

  const joinEncryptedVoiceChannel = (channel, guildIdOverride = null) =>
    joinVoiceChannel({
      channelId: channel.id,
      guildId: guildIdOverride || channel.guild?.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      daveEncryption: true
    });

  const archiveLegacyChannelFile = (filePath) => {
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
        console.warn('failed to archive legacy voice file:', innerErr?.message || innerErr);
      }
    }
    return null;
  };

  const ensureChannelDataReady = () => {
    if (legacyChannelDataHandled) return;
    ensureDataDirs();
    if (fs.existsSync(legacyTtsToggleFile)) {
      const legacy = readJsonFile(legacyTtsToggleFile, { fallback: null });
      if (typeof legacy?.enabled === 'boolean') legacyTtsDefault = legacy.enabled;
      archiveLegacyChannelFile(legacyTtsToggleFile);
    }
    if (fs.existsSync(legacyVoiceSessionFile)) {
      const legacy = readJsonFile(legacyVoiceSessionFile, { fallback: null });
      const sessions = Array.isArray(legacy)
        ? legacy
        : Array.isArray(legacy?.sessions)
          ? legacy.sessions
          : [];
      sessions.forEach((session) => {
        const channelId = session?.channelId;
        if (!channelId) return;
        updateChannelData(channelId, (current) => ({
          ...(current || {}),
          voiceSession: {
            guildId: session?.guildId || null,
            channelId,
            listenChannelId: session?.listenChannelId || null,
            updatedAt: Date.now()
          }
        }));
      });
      archiveLegacyChannelFile(legacyVoiceSessionFile);
    }
    legacyChannelDataHandled = true;
  };

  const getChannelTtsEnabled = (channelId) => {
    ensureChannelDataReady();
    if (!channelId) return legacyTtsDefault;
    const data = readChannelData(channelId, { fallback: null });
    if (typeof data?.ttsEnabled === 'boolean') return data.ttsEnabled;
    return legacyTtsDefault;
  };

  const setChannelTtsEnabled = (channelId, enabled) => {
    ensureChannelDataReady();
    if (!channelId) return false;
    const value = !!enabled;
    updateChannelData(channelId, (current) => ({ ...(current || {}), ttsEnabled: value }));
    return value;
  };

  const persistVoiceSession = (state) => {
    ensureChannelDataReady();
    const channelId = state?.channelId || state?.connection?.joinConfig?.channelId;
    if (!channelId) return;
    const session = {
      guildId: state?.guildId || state?.connection?.joinConfig?.guildId || null,
      channelId,
      listenChannelId: state?.listenChannelId || null,
      updatedAt: Date.now()
    };
    updateChannelData(channelId, (current) => ({ ...(current || {}), voiceSession: session }));
  };

  const clearVoiceSession = (channelId) => {
    if (!channelId) return;
    ensureChannelDataReady();
    updateChannelData(channelId, (current) => {
      const next = { ...(current || {}) };
      delete next.voiceSession;
      return next;
    });
  };

  const loadVoiceSessions = () => {
    ensureChannelDataReady();
    const sessions = [];
    const channelDir = path.join(DEFAULT_BASE_DIR, 'channels');
    let entries = [];
    try {
      entries = fs.readdirSync(channelDir, { withFileTypes: true });
    } catch (err) {
      console.warn('failed to read channel data directory:', err?.message || err);
      return sessions;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const channelId = entry.name.slice(0, -5);
      const data = readJsonFile(path.join(channelDir, entry.name), { fallback: null });
      const session = data?.voiceSession;
      if (!session || (!session.channelId && !channelId)) continue;
      sessions.push({
        guildId: session.guildId || null,
        channelId: session.channelId || channelId,
        listenChannelId: session.listenChannelId || null,
        updatedAt: session.updatedAt || null
      });
    }
    return sessions;
  };

  const persistVoiceSessionsIfAny = () => {
    ensureChannelDataReady();
    const sessions = collectCurrentVoiceSessions();
    sessions.forEach((session) => {
      if (!session?.channelId) return;
      updateChannelData(session.channelId, (current) => ({
        ...(current || {}),
        voiceSession: { ...session, updatedAt: Date.now() }
      }));
    });
  };

  const getStateByChannelId = (channelId) => (channelId ? voiceStates.get(channelId) || null : null);
  const findStateByGuildId = (guildId, { includeInactive = false } = {}) => {
    if (!guildId) return null;
    for (const state of voiceStates.values()) {
      if (!state || state.guildId !== guildId) continue;
      const status = state?.connection?.state?.status;
      if (
        !includeInactive &&
        (!state?.connection ||
          status === VoiceConnectionStatus.Destroyed ||
          status === VoiceConnectionStatus.Disconnected)
      ) {
        continue;
      }
      return state;
    }
    return null;
  };
  const getStateByGuildId = (guildId) => findStateByGuildId(guildId);
  const getStateContext = (state) => ({
    guildId: state?.guildId || state?.connection?.joinConfig?.guildId || null,
    channelId: state?.channelId || state?.connection?.joinConfig?.channelId || null
  });
  const getActiveVoiceState = (message) => {
    const guildId = message?.guild?.id;
    if (guildId) {
      const state = getStateByGuildId(guildId);
      if (state) return state;
    }
    for (const state of voiceStates.values()) {
      if (state?.player?.state?.status === AudioPlayerStatus.Playing) return state;
      if (state?.queue?.length) return state;
    }
    return guildId ? getStateByGuildId(guildId) : null;
  };

  const collectCurrentVoiceSessions = () => {
    const sessions = [];
    for (const state of voiceStates.values()) {
      const channelId = state?.channelId || state?.connection?.joinConfig?.channelId;
      const guildId = state?.guildId || state?.connection?.joinConfig?.guildId;
      if (guildId && channelId) {
        sessions.push({
          guildId,
          channelId,
          listenChannelId: state?.listenChannelId || null
        });
      }
    }
    return sessions;
  };

  const resolveMemberVoiceChannel = async (message) => {
    const direct = message?.member?.voice?.channel || null;
    if (isVoiceBasedChannel(direct)) return direct;
    const guild =
      message?.guild ||
      (message?.guildId ? await client.guilds.fetch(message.guildId).catch(() => null) : null);
    const userId = message?.author?.id || message?.user?.id || null;
    if (!guild || !userId || !guild.members?.fetch) return null;
    try {
      const member = await guild.members.fetch(userId);
      return member?.voice?.channel || null;
    } catch (_) {
      return null;
    }
  };

  const isVoiceBasedChannel = (channel) => {
    if (!channel) return false;
    if (typeof channel.isVoiceBased === 'function') return channel.isVoiceBased();
    const type = channel.type;
    return type === 2 || type === 13; // GuildVoice or GuildStageVoice
  };

  const fetchChannelById = async (id, guild) => {
    if (!id) return null;
    let channel = guild?.channels?.cache?.get(id) || null;
    if (!channel && guild?.channels?.fetch) {
      try {
        channel = await guild.channels.fetch(id);
      } catch (_) {
        channel = null;
      }
    }
    if (!channel && client.channels?.fetch) {
      try {
        channel = await client.channels.fetch(id);
      } catch (_) {
        channel = null;
      }
    }
    if (channel && guild) {
      const channelGuildId = channel.guild?.id || null;
      if (!channelGuildId || channelGuildId !== guild.id) return null;
    }
    return channel;
  };

  const getLatestSavedVoiceSession = (guildId) => {
    if (!guildId) return null;
    const sessions = loadVoiceSessions();
    let best = null;
    for (const session of sessions) {
      if (!session?.channelId || session.guildId !== guildId) continue;
      const updatedAt = Number(session.updatedAt) || 0;
      if (!best || updatedAt > best.updatedAt) {
        best = { ...session, updatedAt };
      }
    }
    return best;
  };

  const getDisconnectReasonLabel = (connectionState) => {
    const reason = connectionState?.reason;
    if (reason === undefined || reason === null) return null;
    return VoiceConnectionDisconnectReason[reason] || String(reason);
  };

  const describeConnectionState = (connectionState) => {
    if (!connectionState?.status) return 'unknown';
    const parts = [connectionState.status];
    const reason = getDisconnectReasonLabel(connectionState);
    if (reason) parts.push(`reason=${reason}`);
    if (typeof connectionState?.closeCode === 'number') parts.push(`closeCode=${connectionState.closeCode}`);
    return parts.join(' ');
  };

  const logConnectionStateChange = (state, oldState, newState) => {
    const { guildId, channelId } = getStateContext(state);
    console.log(
      `[voice] state change guild=${guildId || 'unknown'} channel=${channelId || 'unknown'} ${describeConnectionState(oldState)} -> ${describeConnectionState(newState)}`
    );
  };

  const waitForTransientRecovery = (connection) =>
    Promise.race([
      entersState(connection, VoiceConnectionStatus.Signalling, VOICE_DISCONNECT_GRACE_MS),
      entersState(connection, VoiceConnectionStatus.Connecting, VOICE_DISCONNECT_GRACE_MS),
      entersState(connection, VoiceConnectionStatus.Ready, VOICE_DISCONNECT_GRACE_MS)
    ]);

  const resolveVoiceChannel = async (message) => {
    const memberChannel = await resolveMemberVoiceChannel(message);
    if (isVoiceBasedChannel(memberChannel)) return memberChannel;

    const guild =
      message?.guild ||
      (message?.guildId ? await client.guilds.fetch(message.guildId).catch(() => null) : null);
    const guildId = guild?.id || null;
    if (guildId) {
      const state = getStateByGuildId(guildId);
      const joinedId = state?.channelId || state?.connection?.joinConfig?.channelId;
      if (joinedId) {
        const existingChannel = await fetchChannelById(joinedId, guild);
        if (isVoiceBasedChannel(existingChannel)) return existingChannel;
      }
      const saved = getLatestSavedVoiceSession(guildId);
      if (saved?.channelId) {
        const savedChannel = await fetchChannelById(saved.channelId, guild);
        if (isVoiceBasedChannel(savedChannel)) return savedChannel;
      }
    }

    const fallbackChannelId = guildId && typeof getDefaultVoiceChannelId === 'function'
      ? getDefaultVoiceChannelId(guildId)
      : null;
    const fallbackChannel = await fetchChannelById(fallbackChannelId, guild);
    if (isVoiceBasedChannel(fallbackChannel)) return fallbackChannel;

    return null;
  };

  const clearVoiceReconnect = (state) => {
    if (!state) return;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.reconnectAttempts = 0;
  };

  const handleDisconnectedStateChange = async (state, connection, oldState, newState) => {
    const { guildId, channelId } = getStateContext(state);
    if (state.isLeaving) {
      console.log(
        `[voice] ignoring disconnected state during leave guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}`
      );
      return;
    }
    if (state.connection !== connection) {
      console.log(
        `[voice] ignoring stale disconnected state for guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}`
      );
      return;
    }

    const reason = newState?.reason;
    const reasonLabel = getDisconnectReasonLabel(newState) || 'unknown';
    const closeCode = typeof newState?.closeCode === 'number' ? newState.closeCode : null;

    if (reason === VoiceConnectionDisconnectReason.Manual) {
      console.warn(
        `[voice] terminal disconnect guild=${guildId || 'unknown'} channel=${channelId || 'unknown'} reason=${reasonLabel}`
      );
      if (guildId) leaveVoice(guildId);
      return;
    }

    if (reason === VoiceConnectionDisconnectReason.WebSocketClose && closeCode === 4014) {
      console.warn(
        `[voice] disconnected with closeCode=4014 guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}; waiting ${VOICE_DISCONNECT_GRACE_MS}ms for recovery`
      );
      try {
        await waitForTransientRecovery(connection);
        console.log(
          `[voice] transient disconnect recovered guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}`
        );
        return;
      } catch (_) {
        console.warn(
          `[voice] terminal disconnect after recovery timeout guild=${guildId || 'unknown'} channel=${channelId || 'unknown'} reason=${reasonLabel} closeCode=${closeCode}`
        );
        if (guildId) leaveVoice(guildId);
        return;
      }
    }

    console.warn(
      `[voice] recoverable disconnect detected guild=${guildId || 'unknown'} channel=${channelId || 'unknown'} reason=${reasonLabel}${closeCode !== null ? ` closeCode=${closeCode}` : ''}`
    );
    scheduleVoiceReconnect(state);
  };

  const scheduleVoiceReconnect = (state) => {
    if (!state || state.isLeaving) return;
    const { guildId, channelId } = getStateContext(state);
    if (!channelId) {
      if (guildId) leaveVoice(guildId);
      return;
    }
    if (state.reconnectTimer) return;
    const attempt = (state.reconnectAttempts || 0) + 1;
    if (attempt > VOICE_RECONNECT_MAX_ATTEMPTS) {
      console.warn(`[voice] max reconnect attempts reached in guild ${guildId || 'unknown'}; giving up`);
      if (guildId) leaveVoice(guildId);
      return;
    }
    state.reconnectAttempts = attempt;
    const delay = Math.min(VOICE_RECONNECT_MAX_DELAY_MS, VOICE_RECONNECT_BASE_DELAY_MS * attempt);
    console.warn(
      `[voice] scheduling reconnect guild=${guildId || 'unknown'} channel=${channelId} attempt=${attempt} delayMs=${delay}`
    );
    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null;
      if (state.isLeaving) return;
      let channel = client.channels.cache.get(channelId);
      if (!channel) {
        try {
          channel = await client.channels.fetch(channelId);
        } catch (err) {
          console.warn(`[voice] failed to fetch channel ${channelId} for reconnect:`, err?.message || err);
          if (guildId) leaveVoice(guildId);
          return;
        }
      }
      if (!channel?.guild?.voiceAdapterCreator) {
        if (guildId) leaveVoice(guildId);
        return;
      }
      const previousConnection = state.connection;
      state.connection = null;
      state.connectionHandlersBound = false;
      try {
        previousConnection?.destroy();
      } catch (_) {
        // ignore
      }
      try {
        const connection = joinEncryptedVoiceChannel(channel, guildId);
        state.connection = connection;
        state.isLeaving = false;
        connection.subscribe(state.player);
        bindVoiceConnectionHandlers(state);
        console.log(
          `[voice] reconnected to channel ${channelId} in guild ${guildId || 'unknown'} on attempt ${attempt}`
        );
        clearVoiceReconnect(state);
      } catch (err) {
        console.warn(
          `[voice] reconnect attempt ${attempt} failed in guild ${guildId || 'unknown'}:`,
          err?.message || err
        );
        scheduleVoiceReconnect(state);
      }
    }, delay);
  };

  const bindVoiceConnectionHandlers = (state) => {
    if (!state || state.connectionHandlersBound || !state.connection) return;
    const connection = state.connection;
    state.connectionHandlersBound = true;
    connection.on('stateChange', (oldState, newState) => {
      logConnectionStateChange(state, oldState, newState);
      if (state.connection !== connection) return;
      if (newState.status === VoiceConnectionStatus.Ready) {
        state.isLeaving = false;
        clearVoiceReconnect(state);
        return;
      }
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void handleDisconnectedStateChange(state, connection, oldState, newState);
        return;
      }
      if (newState.status === VoiceConnectionStatus.Destroyed && !state.isLeaving) {
        const { guildId, channelId } = getStateContext(state);
        console.warn(
          `[voice] connection destroyed without active session cleanup guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}`
        );
        if (guildId) leaveVoice(guildId);
      }
    });
    connection.on('error', (err) => {
      if (state.connection !== connection || state.isLeaving) return;
      const { guildId, channelId } = getStateContext(state);
      const msg = err?.message || err;
      console.warn(
        `[voice] connection error guild=${guildId || 'unknown'} channel=${channelId || 'unknown'}:`,
        msg
      );
      scheduleVoiceReconnect(state);
    });
  };

  const getOrCreateVoice = async (message) => {
    const channel = await resolveVoiceChannel(message);
    const listenChannelId = message?.channelId || message?.channel?.id || null;
    return getOrCreateVoiceForChannel(channel, listenChannelId);
  };

  const getOrCreateVoiceForChannel = (channel, listenChannelId = null) => {
    const guildId = channel?.guild?.id;
    if (!guildId || !channel || !isVoiceBasedChannel(channel)) return null;
    let state = getStateByChannelId(channel.id) || getStateByGuildId(guildId);
    const status = state?.connection?.state?.status;
    if (!state?.connection || status === VoiceConnectionStatus.Destroyed || status === VoiceConnectionStatus.Disconnected) {
      state = null;
    }
    if (state && state.channelId && state.channelId !== channel.id) {
      leaveVoice(guildId);
      state = null;
    }
    if (!state) {
      const connection = joinEncryptedVoiceChannel(channel, guildId);
      const player = createAudioPlayer();
      connection.subscribe(player);
      state = {
        guildId,
        channelId: channel.id,
        connection,
        player,
        queue: [],
        playerHandlersBound: false,
        connectionHandlersBound: false,
        aloneSince: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        isLeaving: false,
        listenChannelId: listenChannelId || null
      };
      voiceStates.set(channel.id, state);
      bindVoiceConnectionHandlers(state);
      console.log(`[voice] joined channel ${channel.id} (${channel.name || 'unknown'}) in guild ${guildId}`);
      persistVoiceSession(state);
    } else {
      state.guildId = guildId;
      state.channelId = channel.id;
      state.isLeaving = false;
      bindVoiceConnectionHandlers(state);
    }
    if (listenChannelId) {
      state.listenChannelId = listenChannelId;
      persistVoiceSession(state);
    }
    clearVoiceReconnect(state);
    return state;
  };

  async function restoreVoiceSessions() {
    const sessions = loadVoiceSessions();
    if (!sessions.length) return;
    for (const session of sessions) {
      const { channelId, listenChannelId } = session || {};
      if (!channelId) continue;
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel) {
          getOrCreateVoiceForChannel(channel, listenChannelId || null);
        }
      } catch (err) {
        console.warn(`failed to restore voice for channel ${channelId}:`, err?.message || err);
      }
    }
  }

  const checkIdleVoices = async () => {
    const now = Date.now();
    for (const state of voiceStates.values()) {
      const channelId = state?.channelId || state?.connection?.joinConfig?.channelId;
      const guildId = state?.guildId || state?.connection?.joinConfig?.guildId;
      if (!guildId || !channelId) continue;
      let channel = client.channels.cache.get(channelId);
      if (!channel) {
        try {
          channel = await client.channels.fetch(channelId);
        } catch {
          continue;
        }
      }
      if (!channel?.members) continue;
      const others = channel.members.filter((m) => m.id !== client.user?.id);
      // Do not auto-leave when alone; keep the connection alive.
      if (others.size === 0) {
        state.aloneSince = now;
      } else {
        state.aloneSince = null;
      }
    }
  };

  const leaveVoice = (guildId) => {
    const state = findStateByGuildId(guildId, { includeInactive: true });
    if (!state) return;
    state.isLeaving = true;
    clearVoiceReconnect(state);
    const channelId = state.channelId || state.connection?.joinConfig?.channelId;
    if (channelId) {
      voiceStates.delete(channelId);
      clearVoiceSession(channelId);
    }
    try {
      state.connection?.destroy();
    } catch (err) {
      console.warn('failed to destroy voice connection:', err?.message || err);
    }
    console.log(`[voice] left channel ${channelId || 'unknown'} in guild ${guildId}`);
    persistVoiceSessionsIfAny();
  };

  const TEMP_BASE = path.join(os.tmpdir(), 'galos-tts');
  const makeTtsPath = () => {
    ensureDir(TEMP_BASE);
    return path.join(TEMP_BASE, `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  };

  const makePlaybackPath = () => {
    ensureDir(TEMP_BASE);
    return path.join(TEMP_BASE, `tts-playback-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  };

  const renderPlaybackWav = (sourcePath, outputPath) =>
    new Promise((resolve, reject) => {
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const proc = spawn(
        ffmpeg,
        [
          '-y',
          '-i',
          sourcePath,
          '-filter:a',
          `atempo=${PLAYBACK_RATE}`,
          '-ac',
          '1',
          '-ar',
          '24000',
          '-codec:a',
          'pcm_s16le',
          outputPath
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        }
      );
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr || `ffmpeg exited with ${code}`));
          return;
        }
        resolve(outputPath);
      });
    });

  const createPlaybackEntry = async (audioPath, keepFile = false) => {
    let playbackPath = audioPath;
    let derivedFilePath = null;
    if (PLAYBACK_RATE !== 1) {
      const candidatePath = makePlaybackPath();
      try {
        playbackPath = await renderPlaybackWav(audioPath, candidatePath);
        derivedFilePath = candidatePath;
      } catch (err) {
        console.warn('failed to speed up playback wav, using original audio:', err?.message || err);
        try {
          if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath);
        } catch (_) {
          // ignore cleanup failures
        }
      }
    }
    const playbackStream = fs.createReadStream(playbackPath);
    return {
      resource: createAudioResource(playbackStream),
      filePath: audioPath,
      derivedFilePath,
      keepFile,
      cleanup: () => {
        try {
          playbackStream.destroy();
        } catch (_) {
          // ignore cleanup failures
        }
      }
    };
  };
  
  const playAudioFile = async (message, audioPath) => {
    if (!audioPath || !fs.existsSync(audioPath)) return false;
    const guildId =
      message?.guild?.id ||
      message?.guildId ||
      message?.channel?.guild?.id ||
      message?.channel?.guildId ||
      null;
    if (!guildId) return false;

    const state = getStateByGuildId(guildId) || getActiveVoiceState(message);
    if (
      !state ||
      !state.connection ||
      !state.player ||
      state.connection?.state?.status === VoiceConnectionStatus.Destroyed ||
      state.connection?.state?.status === VoiceConnectionStatus.Disconnected
    ) {
      return false;
    }

    try {
      const entry = await createPlaybackEntry(audioPath, false);
      playOrQueue(state, entry);
      return true;
    } catch (err) {
      console.warn('failed to queue audio file for playback:', err?.message || err);
      return false;
    }
  };

  const cleanupTempFiles = () => {
    try {
      const entries = fs.readdirSync(TEMP_BASE, { withFileTypes: true });
      for (const entry of entries) {
        try {
          if (entry.isFile()) {
            fs.unlinkSync(path.join(TEMP_BASE, entry.name));
          }
        } catch (_) {
          // ignore per-file cleanup failure
        }
      }
    } catch (_) {
      // ignore missing dir
    }
  };

  const isAllCaps = (text) => {
    const letters = String(text || '').match(/[A-Za-z]/g) || [];
    return letters.length > 0 && letters.every((ch) => ch === ch.toUpperCase());
  };

  const synthesizeTtsToFile = (text) =>
    new Promise((resolve, reject) => {
      ensureDir(ttsTempDir);
      const outPath = makeTtsPath();
      const proc = spawn('python', [ttsScript, text, outPath], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`tts helper exited with ${code}: ${stderr || 'unknown error'}`));
          return;
        }
        resolve({ filePath: outPath, keepFile: false });
      });
    });

  const ttsChains = new Map(); // channelId -> Promise chain

  const enqueueTtsJob = (channelId, job) => {
    if (!channelId) return Promise.resolve();
    const prev = ttsChains.get(channelId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        await job();
      })
      .catch((err) => {
        console.warn('[voice] tts job failed:', err?.message || err);
      });
    ttsChains.set(channelId, next);
    return next;
  };

  const cleanupPlaybackEntry = (entry) => {
    try {
      entry?.cleanup?.();
    } catch (_) {
      // ignore cleanup failures
    }
    if (entry?.derivedFilePath) {
      try {
        fs.unlinkSync(entry.derivedFilePath);
      } catch (err) {
        console.warn('failed to cleanup playback file:', err?.message || err);
      }
    }
    if (entry?.filePath && !entry.keepFile) {
      try {
        fs.unlinkSync(entry.filePath);
      } catch (err) {
        console.warn('failed to cleanup tts file:', err?.message || err);
      }
    }
  };

  const playOrQueue = (state, entry) => {
    state.queue.push(entry);
    const startNext = () => {
      if (!state.queue.length) return;
      const next = state.queue[0];
      state.player.play(next.resource);
    };
    if (!state.playerHandlersBound) {
      state.playerHandlersBound = true;
      state.player.on(AudioPlayerStatus.Idle, () => {
        const finished = state.queue.shift();
        cleanupPlaybackEntry(finished);
        startNext();
      });
      state.player.on('error', (err) => {
        const guildId = state.connection?.joinConfig?.guildId || 'unknown';
        console.warn(`[voice] player error in guild ${guildId}:`, err?.message || err);
        cleanupPlaybackEntry(state.queue.shift());
        startNext();
      });
    }
    if (state.player.state.status !== AudioPlayerStatus.Playing) {
      startNext();
    }
  };

  const stopPlayback = (state) => {
    if (!state?.player) return;
    try {
      state.player.stop(true);
    } catch (err) {
      console.warn('failed to stop tts:', err?.message || err);
    }
    if (Array.isArray(state.queue)) {
      while (state.queue.length) {
        cleanupPlaybackEntry(state.queue.shift());
      }
    }
  };

  const pausePlayback = (state) => (state?.player ? state.player.pause() : false);
  const resumePlayback = (state) => (state?.player ? state.player.unpause() : false);
  const toggleTtsEnabled = (channelId) => {
    if (!channelId) return null;
    const next = !getChannelTtsEnabled(channelId);
    return setChannelTtsEnabled(channelId, next);
  };

  // clean any stray temp files on startup
  cleanupTempFiles();

  const handleAutoTts = async (message) => {
    const channelId = message.channelId || message.channel?.id || null;
    if (!channelId) return;
    if (!getChannelTtsEnabled(channelId)) return;
    const rawText = await replaceMentionsWithNames(message.content || '', message);
    if (rawText.trim().startsWith('?')||rawText.trim().startsWith('!')) return;
    const state = getStateByGuildId(message.guild?.id || '');
    if (!state) return;
    const joinedChannelId = state?.channelId || state?.connection?.joinConfig?.channelId || null;
    const listenChannelId = state?.listenChannelId || joinedChannelId || null;
    if (listenChannelId && channelId !== listenChannelId) return;
    if (
      !state?.connection ||
      !state?.player ||
      state?.connection?.state?.status === VoiceConnectionStatus.Destroyed ||
      state?.connection?.state?.status === VoiceConnectionStatus.Disconnected ||
      !joinedChannelId
    )
      return;
    const guildId = state?.guildId || message.guild?.id || 'unknown';
    const speaker = message.author?.username || 'Someone';
    const speakerId = message.author?.id || 'unknown';
    const attachments = Array.from(message.attachments?.values?.() || []);
    const isImageAttachment = (att) => {
      const name = (att.name || att.url || '').toLowerCase();
      const type = (att.contentType || '').toLowerCase();
      return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(name);
    };
    const isVideoAttachment = (att) => {
      const name = (att.name || att.url || '').toLowerCase();
      const type = (att.contentType || '').toLowerCase();
      return type.startsWith('video/') || /\.(mp4|mov|mkv|avi|webm|wmv|flv|mpeg|mpg)$/.test(name);
    };
    const imageAttachment = attachments.find((att) => isImageAttachment(att));
    const videoAttachment = attachments.find((att) => isVideoAttachment(att));
    const fileAttachment = attachments.find(
      (att) => !isImageAttachment(att) && !isVideoAttachment(att)
    );
    const hasImage = !!imageAttachment;
    const hasVideo = !!videoAttachment;
    const hasFile = !!fileAttachment;
    const videoName = videoAttachment?.name || 'video';
    const fileName = fileAttachment?.name || 'file';
    const stickerName = (message.stickers?.first?.() || message.stickers?.at?.(0) || {}).name || null;
    const hasSticker = !!stickerName;
    let replyTargetName = message.mentions?.repliedUser?.username || null;
    if (!replyTargetName && message.reference?.messageId) {
      const refChannelId = message.reference.channelId || message.channelId;
      try {
        const refChannel =
          message.client.channels.cache.get(refChannelId) ||
          (await message.client.channels.fetch(refChannelId));
        if (refChannel?.messages?.fetch) {
          const refMsg = await refChannel.messages.fetch(message.reference.messageId);
          replyTargetName = refMsg?.author?.username || replyTargetName;
        }
      } catch {
        // ignore fetch failure
      }
    }
    const hasReply = !!replyTargetName;
    const isReply = hasReply || message.type === 19;
    const scrubbed = replaceSpoilersWithBlank(rawText);
    const textBody = scrubbed.replace(/\s+/g, ' ').trim();
    const hasText = !!textBody;
    const textWithoutLinks = scrubbed
      .replace(TENOR_REGEX, '')
      .replace(URL_REGEX, '')
      .replace(/\s+/g, ' ')
      .trim();
    const isUrlOnlyText = hasText && !textWithoutLinks;
    const hasTenorTextLink = TENOR_URL_DETECT_REGEX.test(scrubbed);
    const isLinkOnly = !hasText && (message.embeds?.length || 0) > 0;
    const isGif = message.embeds?.some((emb) => emb?.data?.type === 'gifv');
    const hasForwarded = message.type === 24;
    let sanitizedBody = scrubbed.replace(TENOR_REGEX, '').trim();
    const replyLabel = replyTargetName || 'someone';
    const selfReply = !!replyTargetName && replyTargetName === speaker;
    if (isReply) {
      if (hasText) {
        sanitizedBody = selfReply
          ? `replied to themselves: ${textBody}`
          : `replied to ${replyLabel}: ${textBody}`;
      } else if (hasImage) {
        sanitizedBody = selfReply
          ? 'replied to themselves with an image'
          : `replied to ${replyLabel} with an image`;
      } else if (hasSticker) {
        sanitizedBody = selfReply
          ? `replied to themselves with the sticker ${stickerName}`
          : `replied to ${replyLabel} with the sticker ${stickerName}`;
      } else if (hasVideo) {
        sanitizedBody = selfReply
          ? `replied to themselves with a video ${videoName}`
          : `replied to ${replyLabel} with a video ${videoName}`;
      } else if (hasFile) {
        sanitizedBody = selfReply
          ? `replied to themselves with a file ${fileName}`
          : `replied to ${replyLabel} with a file ${fileName}`;
      } else {
        sanitizedBody = selfReply ? 'replied to themselves' : `replied to ${replyLabel}`;
      }
    }
    const prev = ttsAnnounceState.get(channelId) || { lastSpeakerId: null, lastSpokenAt: 0 };
    const now = Date.now();
    const shouldPrefix =
      !prev.lastSpeakerId || prev.lastSpeakerId !== speakerId || now - prev.lastSpokenAt > TTS_PREFIX_TIMEOUT_MS;
    let sanitized = sanitizedBody;
    const forcePrefix = isReply || hasForwarded;
    if (hasImage && !textBody && !isReply) {
      sanitized = shouldPrefix ? `${speaker} sent an image` : 'sent an image';
    } else if (hasSticker && !textBody && !isReply) {
      sanitized = shouldPrefix ? `${speaker} sent a sticker ${stickerName}` : `sent a sticker ${stickerName}`;
    } else if (hasVideo && !textBody && !isReply) {
      sanitized = shouldPrefix ? `${speaker} sent a video` : `sent a video`;
    } else if (hasFile && !textBody && !isReply) {
      sanitized = shouldPrefix ? `${speaker} sent a file` : `sent a file`;
    } else if ((isLinkOnly || isUrlOnlyText) && !isReply) {
      const linkLabel = isGif || hasTenorTextLink ? 'sent a gif' : 'sent a link';
      sanitized = `${speaker} ${linkLabel}`;
    } else if (isReply) {
      const replyPrefix = speaker;
      sanitized = `${replyPrefix} ${sanitizedBody}`;
    } else if (hasForwarded && !textBody) {
      sanitized = shouldPrefix ? `${speaker} forwarded a message` : 'forwarded a message';
    } else if (hasForwarded && textBody && shouldPrefix) {
      sanitized = `${speaker} forwarded: ${sanitizedBody}`;
    } else {
      // Default text handling: include speaker on first/ spaced messages; omit name on rapid repeats.
      const body = sanitizedBody || textBody || 'blank';
      sanitized = shouldPrefix || forcePrefix ? `${speaker} says ${body}` : body;
    }
    const voiceChannelId = joinedChannelId;
    enqueueTtsJob(voiceChannelId, async () => {
      const stateNow = getStateByChannelId(voiceChannelId) || getStateByGuildId(message.guild?.id || '');
      const currentChannelId = stateNow?.channelId || stateNow?.connection?.joinConfig?.channelId || null;
      if (
        !stateNow?.connection ||
        !stateNow?.player ||
        stateNow?.connection?.state?.status === VoiceConnectionStatus.Destroyed ||
        stateNow?.connection?.state?.status === VoiceConnectionStatus.Disconnected ||
        !currentChannelId
      ) {
        return;
      }
      if (joinedChannelId && currentChannelId !== joinedChannelId) return;
      ttsAnnounceState.set(channelId, { lastSpeakerId: speakerId, lastSpokenAt: Date.now() });
      const channel =
        message.guild?.channels?.cache?.get(joinedChannelId) ||
        (await message.guild?.channels?.fetch?.(joinedChannelId).catch(() => null));
      if (!channel) return;
      let audioPath = null;
      let keepFile = false;
      try {
        const ttsResult = await synthesizeTtsToFile(sanitized);
        audioPath = ttsResult?.filePath || null;
        keepFile = !!ttsResult?.keepFile;
        if (!audioPath) throw new Error('missing audio path');
        const stat = fs.statSync(audioPath);
        if (!stat.size) throw new Error('empty audio');
        playOrQueue(stateNow, await createPlaybackEntry(audioPath, keepFile));
      } catch (err) {
        console.warn('auto-tts failed:', err?.message || err);
        try {
          if (audioPath && !keepFile) fs.unlinkSync(audioPath);
        } catch (_) {
          // ignore
        }
      }
    });
  };

  const URL_REGEX = /https?:\/\/\S+/gi;
  const TENOR_REGEX = /https?:\/\/tenor\.com\/\S+/gi;
  const TENOR_URL_DETECT_REGEX = /https?:\/\/tenor\.com\/\S+/i;

  const getVoiceChannelId = (state) => getStateContext(state).channelId;

  const isAloneForTooLong = (state) => {
    if (!VOICE_ALONE_TIMEOUT_MS) return false;
    if (!state.aloneSince) return false;
    return Date.now() - state.aloneSince > VOICE_ALONE_TIMEOUT_MS;
  };

  const maybeLeaveOnIdle = () => {
    for (const state of voiceStates.values()) {
      if (!state) continue;
      if (state?.connection?.state?.status === VoiceConnectionStatus.Destroyed) {
        if (state.guildId) leaveVoice(state.guildId);
      } else if (state?.connection?.state?.status === VoiceConnectionStatus.Disconnected) {
        scheduleVoiceReconnect(state);
      } else if (isAloneForTooLong(state)) {
        if (state.guildId) leaveVoice(state.guildId);
      }
    }
  };

  return {
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
    playAudioFile,
    maybeLeaveOnIdle,
    getVoiceConnection: (guildId) => getVoiceConnection(guildId)
  };
}

module.exports = { createVoiceManager };
