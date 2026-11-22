/**
 * ============================================================================
 * TOMATO SMP BOT - Real Minecraft Server Status Query & Mineflayer Controller (bot.js)
 *
 * Features:
 * 1. Real TCP Minecraft Server List Ping (SLP) to check actual SERVER STATUS
 *    (ONLINE vs OFFLINE), accurately detecting Aternos offline fallback MOTDs.
 * 2. Separate BOT STATUS (CONNECTED, DISCONNECTED, CONNECTING) verified by
 *    real Mineflayer 'login' + 'spawn' events and live socket inspection.
 * 3. Prevents duplicate bot instances and never generates fake logs or states.
 * ============================================================================
 */

'use strict';

const net = require('net');
const EventEmitter = require('events');
const mineflayer = require('mineflayer');

const CONNECT_TIMEOUT_MS = 20000;
const SPAWN_VERIFY_DELAY_MS = 1500;
const SERVER_PING_INTERVAL_MS = 10000;

class TomatoBotManager extends EventEmitter {
  constructor() {
    super();

    this.config = {
      serverName: 'TOMATO SMP BOT',
      host: process.env.MC_HOST || 'TomatoSMP.aternos.me',
      port: Number(process.env.MC_PORT) || 35074,
      username: process.env.MC_USERNAME || 'TomatoAFK',
      version: process.env.MC_VERSION || false, // false = auto-detect
      autoReconnect: true,
      reconnectDelaySec: 15
    };

    // TWO SEPARATE STATUS INDICATORS
    this.serverStatus = 'OFFLINE'; // 'ONLINE' | 'OFFLINE'
    this.botStatus = 'DISCONNECTED'; // 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING'

    this.serverInfo = {
      version: '-',
      playersOnline: 0,
      playersMax: 0,
      motd: '-',
      lastChecked: null
    };

    this.botInstance = null;
    this.hasLoggedIn = false;
    this.hasSpawned = false;
    this.isManualStop = false;
    this.connectedSince = null;
    this.currentAttemptId = 0;

    this.connectTimeoutTimer = null;
    this.spawnVerifyTimer = null;
    this.reconnectTimer = null;
    this.countdownInterval = null;
    this.reconnectCountdown = 0;

    this.logs = [];
    this.maxLogs = 250;

    // Start background server status check & socket watchdog
    this.startMonitoringLoops();
  }

  /**
   * Add a real timestamped log entry and broadcast to SSE listeners
   */
  addLog(level, message) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time,
      level,
      message
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.log(`[${time}] [${level}] ${message}`);
    this.emit('log', entry);
    this.emitStateUpdate();
  }

  /**
   * Convert Minecraft chat JSON objects or Errors into clean readable strings
   */
  extractReadableText(input) {
    if (!input) return 'No details provided';
    if (typeof input === 'string') return input.replace(/§[0-9a-fk-or]/gi, '').trim() || 'Empty message';

    if (input instanceof Error) {
      const codePart = input.code ? `[${input.code}] ` : '';
      return `${codePart}${input.message}`;
    }

    try {
      if (typeof input === 'object') {
        const parts = [];
        if (typeof input.text === 'string' && input.text.trim()) {
          parts.push(input.text.trim());
        }
        if (typeof input.translate === 'string' && input.translate.trim()) {
          parts.push(input.translate.trim());
        }
        if (Array.isArray(input.with)) {
          const w = input.with.map((x) => this.extractReadableText(x)).filter(Boolean).join(' ');
          if (w) parts.push(w);
        }
        if (Array.isArray(input.extra)) {
          const e = input.extra.map((x) => this.extractReadableText(x)).filter(Boolean).join(' ');
          if (e) parts.push(e);
        }
        if (parts.length > 0) {
          return parts.join(' ').replace(/§[0-9a-fk-or]/gi, '').trim();
        }
        return JSON.stringify(input);
      }
    } catch (_) {
      // Ignore JSON error
    }
    return String(input);
  }

  /**
   * Encode an integer as a Minecraft protocol VarInt buffer
   */
  encodeVarInt(value) {
    const bytes = [];
    let val = value >>> 0;
    do {
      let temp = val & 0x7f;
      val >>>= 7;
      if (val !== 0) {
        temp |= 0x80;
      }
      bytes.push(temp);
    } while (val !== 0);
    return Buffer.from(bytes);
  }

  /**
   * Decode a VarInt from a buffer at the given offset
   */
  decodeVarInt(buffer, offset = 0) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
      if (offset + numRead >= buffer.length) return null;
      read = buffer[offset + numRead];
      const value = read & 0x7f;
      result |= value << (7 * numRead);
      numRead++;
      if (numRead > 5) return null;
    } while ((read & 0x80) !== 0);
    return { value: result, length: numRead };
  }

  /**
   * Real TCP Minecraft Server List Ping (SLP) to check whether TomatoSMP.aternos.me:35074
   * is genuinely ONLINE or OFFLINE on Aternos.
   */
  queryMinecraftServerStatus() {
    return new Promise((resolve) => {
      const host = this.config.host;
      const port = Number(this.config.port);
      const socket = new net.Socket();
      let settled = false;
      let chunks = Buffer.alloc(0);

      const finish = (isOnline, details) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch (_) {}

        this.serverStatus = isOnline ? 'ONLINE' : 'OFFLINE';
        this.serverInfo = {
          version: details.version || '-',
          playersOnline: details.playersOnline || 0,
          playersMax: details.playersMax || 0,
          motd: details.motd || '-',
          lastChecked: new Date().toLocaleTimeString('en-US', { hour12: false })
        };
        this.emitStateUpdate();
        resolve({ serverStatus: this.serverStatus, serverInfo: this.serverInfo });
      };

      socket.setTimeout(6000);

      socket.on('connect', () => {
        try {
          const hostBuf = Buffer.from(host, 'utf8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(port, 0);

          // Handshake packet (Packet ID 0x00, Protocol 767, Host, Port, NextState 1)
          const handshakePayload = Buffer.concat([
            Buffer.from([0x00]),
            this.encodeVarInt(767),
            this.encodeVarInt(hostBuf.length),
            hostBuf,
            portBuf,
            this.encodeVarInt(1)
          ]);
          const handshakePacket = Buffer.concat([
            this.encodeVarInt(handshakePayload.length),
            handshakePayload
          ]);

          // Status Request packet (Length 1, Packet ID 0x00)
          const statusRequestPacket = Buffer.from([0x01, 0x00]);

          socket.write(Buffer.concat([handshakePacket, statusRequestPacket]));
        } catch (err) {
          finish(false, { motd: err.message });
        }
      });

      socket.on('data', (data) => {
        chunks = Buffer.concat([chunks, data]);

        const packetLen = this.decodeVarInt(chunks, 0);
        if (!packetLen) return;

        const totalExpected = packetLen.length + packetLen.value;
        if (chunks.length < totalExpected) return;

        let offset = packetLen.length;
        const packetId = this.decodeVarInt(chunks, offset);
        if (!packetId || packetId.value !== 0x00) {
          finish(false, { motd: 'Invalid SLP response packet' });
          return;
        }
        offset += packetId.length;

        const jsonLen = this.decodeVarInt(chunks, offset);
        if (!jsonLen) {
          finish(false, { motd: 'Incomplete SLP JSON length' });
          return;
        }
        offset += jsonLen.length;

        const jsonStr = chunks.slice(offset, offset + jsonLen.value).toString('utf8');
        try {
          const parsed = JSON.parse(jsonStr);
          const versionName = parsed.version && parsed.version.name
            ? String(parsed.version.name).replace(/§[0-9a-fk-or]/gi, '').trim()
            : 'Unknown';
          const motdText = this.extractReadableText(parsed.description);
          const maxPlayers = parsed.players && typeof parsed.players.max === 'number'
            ? parsed.players.max
            : 0;
          const onlinePlayers = parsed.players && typeof parsed.players.online === 'number'
            ? parsed.players.online
            : 0;

          // Aternos offline fallback proxy returns maxPlayers === 0, version "● Offline", or MOTD "This server is offline."
          const isAternosOffline =
            maxPlayers === 0 ||
            /offline/i.test(versionName) ||
            /server is offline/i.test(motdText) ||
            /offline/i.test(motdText);

          finish(!isAternosOffline, {
            version: versionName,
            playersOnline: onlinePlayers,
            playersMax: maxPlayers,
            motd: motdText
          });
        } catch (err) {
          finish(false, { motd: 'Failed to parse server status JSON' });
        }
      });

      socket.on('timeout', () => {
        finish(false, { motd: 'Server ping timed out (OFFLINE)' });
      });

      socket.on('error', (err) => {
        finish(false, { motd: err.code || err.message || 'Connection refused' });
      });

      socket.connect(port, host);
    });
  }

  /**
   * Check whether the Mineflayer bot is genuinely connected, logged in, and spawned
   */
  isBotTrulyConnected() {
    if (!this.botInstance || !this.hasLoggedIn || !this.hasSpawned) {
      return false;
    }
    const client = this.botInstance._client;
    if (!client || !client.socket) {
      return false;
    }
    if (client.socket.destroyed || !client.socket.writable) {
      return false;
    }
    if (!this.botInstance.entity || !this.botInstance.entity.position) {
      return false;
    }
    return true;
  }

  /**
   * Clear all active timers
   */
  clearAllTimers() {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.spawnVerifyTimer) {
      clearTimeout(this.spawnVerifyTimer);
      this.spawnVerifyTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.reconnectCountdown = 0;
  }

  /**
   * Reset bot state strictly to DISCONNECTED
   */
  resetBotToDisconnected() {
    this.botStatus = 'DISCONNECTED';
    this.hasLoggedIn = false;
    this.hasSpawned = false;
    this.connectedSince = null;
    this.emitStateUpdate();
  }

  /**
   * Cleanly destroy current Mineflayer instance
   */
  destroyBotInstance() {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.spawnVerifyTimer) {
      clearTimeout(this.spawnVerifyTimer);
      this.spawnVerifyTimer = null;
    }
    if (this.botInstance) {
      try {
        this.botInstance.removeAllListeners();
        if (this.botInstance._client) {
          this.botInstance._client.removeAllListeners();
        }
        this.botInstance.quit();
      } catch (_) {}
      this.botInstance = null;
    }
  }

  /**
   * Start the Mineflayer bot after checking real server status
   */
  async startBot() {
    if (this.botInstance || this.botStatus === 'CONNECTING' || this.isBotTrulyConnected()) {
      this.addLog('WARN', 'Duplicate connection prevented: Bot is already CONNECTING or CONNECTED.');
      return { ok: false, message: 'Bot is already connecting or connected.' };
    }

    this.clearAllTimers();
    this.resetBotToDisconnected();
    this.isManualStop = false;
    this.botStatus = 'CONNECTING';
    const attemptId = ++this.currentAttemptId;
    this.emitStateUpdate();

    this.addLog(
      'INFO',
      `Checking real server status for ${this.config.host}:${this.config.port} before connecting...`
    );

    const pingResult = await this.queryMinecraftServerStatus();

    // If user clicked Stop while ping was in flight, abort
    if (attemptId !== this.currentAttemptId || this.isManualStop) {
      return { ok: false, message: 'Connection cancelled.' };
    }

    if (pingResult.serverStatus !== 'ONLINE') {
      const reason = pingResult.serverInfo.motd || 'Server is offline';
      this.addLog(
        'ERROR',
        `Cannot connect bot: Server ${this.config.host}:${this.config.port} is OFFLINE (${reason}).`
      );
      this.resetBotToDisconnected();
      this.scheduleAutoReconnect('Aternos server is OFFLINE');
      return {
        ok: false,
        message: `Server is currently OFFLINE (${reason}). Bot Status is DISCONNECTED.`
      };
    }

    this.addLog(
      'INFO',
      `Server is ONLINE (${pingResult.serverInfo.version}). Connecting bot '${this.config.username}'...`
    );

    this.connectTimeoutTimer = setTimeout(() => {
      if (attemptId !== this.currentAttemptId) return;
      if (!this.isBotTrulyConnected()) {
        this.addLog(
          'ERROR',
          `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s without completing login and spawn.`
        );
        this.destroyBotInstance();
        this.resetBotToDisconnected();
        this.scheduleAutoReconnect('Connection timeout');
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      this.botInstance = mineflayer.createBot({
        host: this.config.host,
        port: Number(this.config.port),
        username: this.config.username,
        auth: 'offline',
        version: this.config.version || false,
        viewDistance: 'tiny',
        checkTimeoutInterval: 60 * 1000,
        hideErrors: true
      });
    } catch (err) {
      this.addLog('ERROR', `Mineflayer creation failed: ${this.extractReadableText(err)}`);
      this.destroyBotInstance();
      this.resetBotToDisconnected();
      this.scheduleAutoReconnect(err.message || 'Creation error');
      return { ok: false, message: err.message };
    }

    this.botInstance.once('login', () => {
      if (attemptId !== this.currentAttemptId || !this.botInstance) return;
      this.hasLoggedIn = true;
      this.addLog(
        'INFO',
        `Login packet accepted (v${this.botInstance.version || 'auto'}). Waiting for world spawn...`
      );
    });

    this.botInstance.once('spawn', () => {
      if (attemptId !== this.currentAttemptId || !this.botInstance) return;
      this.hasLoggedIn = true;
      this.hasSpawned = true;

      this.spawnVerifyTimer = setTimeout(() => {
        if (attemptId !== this.currentAttemptId) return;

        if (!this.isBotTrulyConnected()) {
          this.addLog(
            'ERROR',
            'Spawn verification failed: Server closed connection immediately.'
          );
          this.destroyBotInstance();
          this.resetBotToDisconnected();
          this.scheduleAutoReconnect('Immediate kick after spawn');
          return;
        }

        if (this.connectTimeoutTimer) {
          clearTimeout(this.connectTimeoutTimer);
          this.connectTimeoutTimer = null;
        }

        this.botInstance.physicsEnabled = false;
        this.botStatus = 'CONNECTED';
        this.serverStatus = 'ONLINE';
        this.connectedSince = Date.now();

        const p = this.botInstance.entity.position;
        const posStr = `X:${Math.floor(p.x)} Y:${Math.floor(p.y)} Z:${Math.floor(p.z)}`;
        this.addLog(
          'SUCCESS',
          `Bot '${this.config.username}' is now CONNECTED and spawned at ${posStr}.`
        );
        this.emitStateUpdate();
      }, SPAWN_VERIFY_DELAY_MS);
    });

    this.botInstance.on('kicked', (reason, loggedIn) => {
      if (attemptId !== this.currentAttemptId) return;
      const text = this.extractReadableText(reason);
      this.addLog('ERROR', `Kicked from server (loggedIn=${loggedIn}): ${text}`);
    });

    this.botInstance.on('error', (err) => {
      if (attemptId !== this.currentAttemptId) return;
      this.addLog('ERROR', `Socket/Protocol Error: ${this.extractReadableText(err)}`);
    });

    this.botInstance.on('end', (reason) => {
      if (attemptId !== this.currentAttemptId) return;
      const text = this.extractReadableText(reason);
      const wasConnected = this.botStatus === 'CONNECTED';

      this.destroyBotInstance();
      this.resetBotToDisconnected();
      this.queryMinecraftServerStatus();

      if (wasConnected) {
        this.addLog('WARN', `Bot DISCONNECTED from server | Reason: ${text}`);
      } else {
        this.addLog('ERROR', `Bot connection attempt ended (DISCONNECTED) | Reason: ${text}`);
      }

      if (!this.isManualStop && this.config.autoReconnect) {
        this.scheduleAutoReconnect(text);
      }
    });

    return { ok: true, message: 'Connecting to server...' };
  }

  /**
   * Stop the bot and cancel any pending auto-reconnect
   */
  stopBot(reason = 'Stopped by user from dashboard') {
    this.isManualStop = true;
    this.currentAttemptId++;
    this.clearAllTimers();
    this.destroyBotInstance();
    this.resetBotToDisconnected();
    this.addLog('INFO', `Bot stopped (BOT STATUS: DISCONNECTED) — ${reason}`);
    return { ok: true, message: 'Bot stopped.' };
  }

  /**
   * Toggle Auto-Reconnect
   */
  setAutoReconnect(enabled) {
    this.config.autoReconnect = Boolean(enabled);
    if (!this.config.autoReconnect && this.reconnectTimer) {
      this.clearAllTimers();
      this.addLog('INFO', 'Auto-Reconnect turned OFF; cancelled pending retry timer.');
    } else {
      this.addLog('INFO', `Auto-Reconnect set to ${this.config.autoReconnect ? 'ON' : 'OFF'}.`);
    }
    this.emitStateUpdate();
  }

  /**
   * Schedule automatic reconnect while keeping BOT STATUS strictly DISCONNECTED
   */
  scheduleAutoReconnect(lastReason) {
    this.resetBotToDisconnected();
    if (this.isManualStop || !this.config.autoReconnect || this.reconnectTimer) {
      return;
    }

    const delaySec = Math.max(5, Number(this.config.reconnectDelaySec) || 15);
    this.reconnectCountdown = delaySec;
    this.addLog(
      'INFO',
      `Auto-Reconnect in ${delaySec}s (BOT STATUS: DISCONNECTED | Last reason: ${lastReason}).`
    );

    this.countdownInterval = setInterval(() => {
      if (this.reconnectCountdown > 0) {
        this.reconnectCountdown -= 1;
        this.emitStateUpdate();
      }
    }, 1000);

    this.reconnectTimer = setTimeout(() => {
      if (this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
      this.reconnectTimer = null;
      this.reconnectCountdown = 0;

      if (!this.isManualStop) {
        this.startBot();
      }
    }, delaySec * 1000);
  }

  /**
   * Clear console logs
   */
  clearLogs() {
    this.logs = [];
    this.addLog('INFO', 'Console logs cleared.');
  }

  /**
   * Build the synchronized state snapshot for REST and SSE clients
   */
  getSnapshot() {
    const trulyConnected = this.isBotTrulyConnected();
    if (this.botStatus === 'CONNECTED' && !trulyConnected) {
      this.botStatus = 'DISCONNECTED';
      this.connectedSince = null;
    }

    const effectiveBotStatus = trulyConnected
      ? 'CONNECTED'
      : this.botStatus === 'CONNECTING'
      ? 'CONNECTING'
      : 'DISCONNECTED';

    const uptimeSeconds =
      trulyConnected && this.connectedSince
        ? Math.max(0, Math.floor((Date.now() - this.connectedSince) / 1000))
        : 0;

    return {
      serverStatus: this.serverStatus, // 'ONLINE' | 'OFFLINE'
      botStatus: effectiveBotStatus,   // 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING'
      uptimeSeconds,
      autoReconnect: this.config.autoReconnect,
      isReconnecting: Boolean(this.reconnectTimer),
      reconnectCountdown: this.reconnectCountdown,
      config: {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username
      },
      serverInfo: this.serverInfo,
      logs: this.
