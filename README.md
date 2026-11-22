# TOMATO SMP BOT — Replit और Termux Minecraft AFK Bot Control Website (पूरी हिंदी गाइड)

## 1. पुराना Replit प्रोजेक्ट क्यों काम करना बंद कर गया था? (Inspection & Root Cause Analysis)

आपके मौजूदा प्रोजेक्ट की जाँच करने पर **4 मुख्य तकनीकी कारण (Bugs)** मिले जिनकी वजह से वह Replit पर काम नहीं कर रहा था या गलत स्टेटस दिखा रहा था:

1. **`127.0.0.1` (Localhost) बाइंडिंग और IP ब्लॉक की समस्या:**
   पुराने `server.js` में सर्वर केवल `127.0.0.1` पर बाइंड था और `verifyLocalRequest` मिडलवेयर बाहरी प्रॉक्सी रिक्वेस्ट को `403 Forbidden` कर देता था। **Replit** पर वेबव्यू (Webview) कंटेनर प्रॉक्सी के ज़रिए चलता है, इसलिए उसे हमेशा **`0.0.0.0`** और **`process.env.PORT || 3000`** पर सुनना (listen करना) ज़रूरी है।
2. **`SERVER STATUS` और `BOT STATUS` का आपस में मिल जाना:**
   पहले केवल एक ही स्टेटस बैज था। जब Aternos सर्वर ऑफलाइन होता है, तब भी Aternos का प्रॉक्सी पोर्ट `35074` खुला रखता है और MOTD में `"This server is offline."` या `maxPlayers: 0` भेजता है। बिना असली Minecraft Server List Ping (SLP) जाँच के बॉट जोड़ने पर लॉगिन हैंडशेक शुरू होकर तुरंत किक हो जाता था। अब `bot.js` में **असली TCP Server List Ping** जोड़ा गया है जो पहले **SERVER STATUS (`ONLINE` / `OFFLINE`)** की जाँच करता है और उसे **BOT STATUS (`CONNECTED` / `DISCONNECTED` / `CONNECTING`)** से बिल्कुल अलग रखता है।
3. **अलग `bot.js` मॉड्यूल और लाइव स्ट्रीम (SSE) की कमी:**
   पहले सारा कोड एक ही फाइल में था और हर सेकंड बार-बार HTTP पोलिंग हो रही थी। अब इसे साफ तौर पर **`server.js`** (Express + Server-Sent Events `/api/stream`) और **`bot.js`** ([Mineflayer](https://www.npmjs.com/package/mineflayer) + TCP Server Status Query) में बाँट दिया गया है ताकि बैकएंड और फ्रंटएंड हमेशा सिंक में रहें।
4. **Replit Start Configuration (`.replit` और `package.json`):**
   Replit को सही पोर्ट और कमांड बताने के लिए `.replit` फाइल (`run = "npm start"`) और `package.json` में `"start": "node server.js"` सेट कर दिया गया है।

## 2. प्रोजेक्ट फोल्डर स्ट्रक्चर (Project Folder Structure)

```text
tomato-smp-bot/
├── package.json         # Node.js dependencies (express ^5.3.0, mineflayer ^4.39.0) और start script
├── .replit              # Replit रन कमांड और पोर्ट 3000 मैपिंग
├── server.js            # Express सर्वर (process.env.PORT, 0.0.0.0) + Live SSE Stream (/api/stream)
├── bot.js               # असली Minecraft TCP Server Status Query + Mineflayer Bot Engine
└── public/
    ├── index.html       # क्लीन ब्लैक और ग्रीन मोबाइल डैशबोर्ड (TOMATO SMP BOT)
    ├── style.css        # डार्क ग्रे, ब्लैक और ग्रीन मिनिमल कार्ड स्टाइल (बिना फालतू एनिमेशन)
    └── script.js        # लाइव SSE कनेक्शन और बटन कंट्रोल्स
```

## 3. सभी फाइलों का पूरा कोड (Complete Source Code)

### (1) `package.json`
```json
{
  "name": "tomato-smp-bot",
  "version": "2.0.0",
  "description": "TOMATO SMP BOT - Replit & Termux Compatible Minecraft Aternos AFK Bot Control Panel",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "keywords": [
    "minecraft",
    "aternos",
    "mineflayer",
    "express",
    "replit",
    "tomato-smp-bot"
  ],
  "author": "TomatoAFK",
  "license": "MIT",
  "Engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "express": "^5.3.0",
    "mineflayer": "^4.39.0"
  }
}
```

### (2) `server.js`
```javascript
/**
 * ============================================================================
 * TOMATO SMP BOT - Express Backend & SSE Live Stream Server (server.js)
 * Compatible with Replit (0.0.0.0 + process.env.PORT) and Android Termux
 * ============================================================================
 */

'use strict';

const path = require('path');
const express = require('express');
const botManager = require('./bot');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0'; // Required for Replit webview & local network compatibility

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Active Server-Sent Events (SSE) clients for real-time live updates
const sseClients = new Set();

function broadcastSSE(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

botManager.on('state', (snapshot) => {
  broadcastSSE('state', snapshot);
});

botManager.on('log', (entry) => {
  broadcastSSE('log', entry);
});

// ============================================================================
// REST & SSE ENDPOINTS
// ============================================================================

// 1. Server-Sent Events (SSE) Live Stream
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send immediate snapshot on connect
  res.write(`event: state\ndata: ${JSON.stringify(botManager.getSnapshot())}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// 2. Current synchronized state snapshot
app.get('/api/status', (req, res) => {
  res.json(botManager.getSnapshot());
});

// 3. Force a real Minecraft Server Status Query
app.post('/api/ping-server', async (req, res) => {
  await botManager.queryMinecraftServerStatus();
  res.json(botManager.getSnapshot());
});

// 4. Start Bot
app.post('/api/start', async (req, res) => {
  const result = await botManager.startBot();
  res.status(result.ok ? 200 : 400).json({
    ...result,
    snapshot: botManager.getSnapshot()
  });
});

// 5. Stop Bot
app.post('/api/stop', (req, res) => {
  const result = botManager.stopBot('Stop Bot button pressed on dashboard');
  res.json({
    ...result,
    snapshot: botManager.getSnapshot()
  });
});

// 6. Toggle Auto-Reconnect
app.post('/api/autoreconnect', (req, res) => {
  const enabled = Boolean(req.body && req.body.enabled);
  botManager.setAutoReconnect(enabled);
  res.json({
    ok: true,
    autoReconnect: botManager.config.autoReconnect,
    snapshot: botManager.getSnapshot()
  });
});

// 7. Clear Live Console
app.post('/api/logs/clear', (req, res) => {
  botManager.clearLogs();
  res.json({
    ok: true,
    snapshot: botManager.getSnapshot()
  });
});

// ============================================================================
// START SERVER & GRACEFUL SHUTDOWN
// ============================================================================
const server = app.listen(PORT, HOST, () => {
  botManager.addLog(
    'INFO',
    `TOMATO SMP BOT Server listening on http://${HOST}:${PORT} (Target: ${botManager.config.host}:${botManager.config.port})`
  );
});

function shutdown(signal) {
  console.log('');
  botManager.addLog('WARN', `Received ${signal}. Stopping bot and closing server...`);
  botManager.stopBot('Server process shutting down');
  for (const client of sseClients) {
    try {
      client.end();
    } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

### (3) `bot.js`
```javascript
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
      logs: this.logs
    };
  }

  emitStateUpdate() {
    this.emit('state', this.getSnapshot());
  }

  /**
   * Periodic background loops for server status ping and socket integrity
   */
  startMonitoringLoops() {
    // Initial server ping on startup
    this.queryMinecraftServerStatus();

    // Re-check real Minecraft server status every 10 seconds
    setInterval(() => {
      if (this.isBotTrulyConnected()) {
        this.serverStatus = 'ONLINE';
        this.emitStateUpdate();
      } else {
        this.queryMinecraftServerStatus();
      }
    }, SERVER_PING_INTERVAL_MS);

    // 1-second watchdog for uptime and socket state
    setInterval(() => {
      if (this.botStatus === 'CONNECTED' && !this.isBotTrulyConnected()) {
        this.addLog('ERROR', 'Watchdog: Bot socket closed unexpectedly. Setting BOT STATUS to DISCONNECTED.');
        this.destroyBotInstance();
        this.resetBotToDisconnected();
        this.queryMinecraftServerStatus();
      } else if (this.botStatus === 'CONNECTED') {
        this.emitStateUpdate();
      }
    }, 1000);
  }
}

module.exports = new TomatoBotManager();
```

### (4) `public/index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TOMATO SMP BOT</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header-card">
      <div class="title-group">
        <h1>TOMATO SMP BOT</h1>
        <p class="server-address" id="server-address">TomatoSMP.aternos.me:35074 • TomatoAFK</p>
      </div>
      <button id="btn-refresh-ping" type="button" class="btn-outline">Check Server</button>
    </header>

    <!-- Two Separate Status Indicators + Uptime -->
    <section class="status-grid">
      <div class="card status-card">
        <span class="label">SERVER STATUS</span>
        <div class="status-row">
          <span id="server-dot" class="dot dot-red"></span>
          <strong id="server-status-text" class="status-value text-red">OFFLINE</strong>
        </div>
        <span id="server-subtext" class="subtext">Checking Aternos server...</span>
      </div>

      <div class="card status-card">
        <span class="label">BOT STATUS</span>
        <div class="status-row">
          <span id="bot-dot" class="dot dot-red"></span>
          <strong id="bot-status-text" class="status-value text-red">DISCONNECTED</strong>
        </div>
        <span id="bot-subtext" class="subtext">Bot: TomatoAFK</span>
      </div>

      <div class="card status-card">
        <span class="label">UPTIME COUNTER</span>
        <strong id="uptime-text" class="status-value mono">00:00:00</strong>
        <span id="reconnect-subtext" class="subtext">Counts only real connected time</span>
      </div>
    </section>

    <!-- Large Bot Controls Card -->
    <section class="card controls-card">
      <div class="buttons-row">
        <button id="btn-start" type="button" class="btn-large btn-start">START BOT</button>
        <button id="btn-stop" type="button" class="btn-large btn-stop" disabled>STOP BOT</button>
      </div>

      <div class="autoreconnect-row">
        <label for="toggle-autoreconnect" class="toggle-label">
          <input id="toggle-autoreconnect" type="checkbox" checked />
          <span>AUTO RECONNECT (15s Interval)</span>
        </label>
        <span id="stream-indicator" class="stream-badge">LIVE SSE</span>
      </div>
    </section>

    <!-- Live Console Card -->
    <section class="card console-card">
      <div class="console-header">
        <h2>LIVE CONSOLE</h2>
        <button id="btn-clear-logs" type="button" class="btn-outline">Clear</button>
      </div>
      <div id="console-box" class="console-box" aria-live="polite">
        <div class="log-item log-info">[SYSTEM] Connecting to live backend stream...</div>
      </div>
    </section>
  </div>

  <script src="script.js"></script>
</body>
</html>
```

### (5) `public/style.css`
```css
:root {
  --bg-black: #0a0a0a;
  --bg-card: #141414;
  --bg-inner: #1c1c1c;
  --border-grey: #2a2a2a;
  --text-main: #f5f5f5;
  --text-muted: #9ca3af;
  --green: #22c55e;
  --green-dark: #16a34a;
  --red: #ef4444;
  --red-dark: #dc2626;
  --amber: #f59e0b;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--bg-black);
  color: var(--text-main);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  min-height: 100vh;
  padding: 12px;
  line-height: 1.45;
}

.container {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card,
.header-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-grey);
  border-radius: 12px;
  padding: 16px;
}

.header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-left: 4px solid var(--green);
}

.title-group h1 {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: 0.03em;
  color: var(--text-main);
}

.server-address {
  font-size: 0.82rem;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  margin-top: 2px;
}

.status-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

@media (min-width: 600px) {
  .status-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

.status-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-green {
  background-color: var(--green);
}

.dot-red {
  background-color: var(--red);
}

.dot-amber {
  background-color: var(--amber);
}

.status-value {
  font-size: 1.15rem;
  font-weight: 800;
}

.text-green {
  color: var(--green);
}

.text-red {
  color: var(--red);
}

.text-amber {
  color: var(--amber);
}

.subtext {
  font-size: 0.76rem;
  color: var(--text-muted);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.controls-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.buttons-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.btn-large {
  border: none;
  border-radius: 10px;
  padding: 16px 14px;
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: 0.03em;
  color: #ffffff;
  cursor: pointer;
}

.btn-start {
  background-color: var(--green-dark);
  border: 1px solid var(--green);
}

.btn-stop {
  background-color: var(--red-dark);
  border: 1px solid var(--red);
}

.btn-large:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.autoreconnect-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-grey);
  flex-wrap: wrap;
}

.toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}

.toggle-label input[type='checkbox'] {
  width: 18px;
  height: 18px;
  accent-color: var(--green);
}

.stream-badge {
  font-size: 0.72rem;
  font-weight: 700;
  padding: 4px 8px;
  border-radius: 6px;
  background-color: var(--bg-inner);
  border: 1px solid var(--border-grey);
  color: var(--green);
}

.btn-outline {
  background-color: var(--bg-inner);
  color: var(--text-main);
  border: 1px solid var(--border-grey);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.console-header h2 {
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.console-box {
  background-color: #050505;
  border: 1px solid var(--border-grey);
  border-radius: 8px;
  height: 260px;
  overflow-y: auto;
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
}

.log-item {
  padding: 4px 0;
  border-bottom: 1px solid #161616;
  word-break: break-word;
}

.log-info {
  color: #d1d5db;
}

.log-success {
  color: var(--green);
}

.log-warn {
  color: var(--amber);
}

.log-error {
  color: var(--red);
}
```

### (6) `public/script.js`
```javascript
/**
 * ============================================================================
 * TOMATO SMP BOT - Frontend Live Controller (script.js)
 * Uses Server-Sent Events (/api/stream) + REST endpoints (/api/*)
 * Keeps SERVER STATUS (ONLINE/OFFLINE) and BOT STATUS (CONNECTED/DISCONNECTED/CONNECTING)
 * strictly separate. Zero fake logs or demo connections.
 * ============================================================================
 */

'use strict';

const serverDot = document.getElementById('server-dot');
const serverStatusText = document.getElementById('server-status-text');
const serverSubtext = document.getElementById('server-subtext');

const botDot = document.getElementById('bot-dot');
const botStatusText = document.getElementById('bot-status-text');
const botSubtext = document.getElementById('bot-subtext');

const uptimeText = document.getElementById('uptime-text');
const reconnectSubtext = document.getElementById('reconnect-subtext');
const serverAddressEl = document.getElementById('server-address');
const streamIndicator = document.getElementById('stream-indicator');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnRefreshPing = document.getElementById('btn-refresh-ping');
const btnClearLogs = document.getElementById('btn-clear-logs');
const toggleAutoReconnect = document.getElementById('toggle-autoreconnect');
const consoleBox = document.getElementById('console-box');

let lastLogCount = -1;

function formatHMS(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function renderLogs(logs) {
  if (!Array.isArray(logs)) return;
  if (logs.length === lastLogCount) return;
  lastLogCount = logs.length;

  consoleBox.innerHTML = '';
  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-item log-info';
    empty.textContent = 'No logs available.';
    consoleBox.appendChild(empty);
    return;
  }

  logs.forEach((entry) => {
    const div = document.createElement('div');
    const cls =
      entry.level === 'SUCCESS'
        ? 'log-success'
        : entry.level === 'WARN'
        ? 'log-warn'
        : entry.level === 'ERROR'
        ? 'log-error'
        : 'log-info';
    div.className = `log-item ${cls}`;
    div.textContent = `[${entry.time}] [${entry.level}] ${entry.message}`;
    consoleBox.appendChild(div);
  });

  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function applySnapshot(snapshot) {
  if (!snapshot) return;

  // 1. SERVER STATUS (ONLINE vs OFFLINE)
  const srvOnline = snapshot.serverStatus === 'ONLINE';
  serverStatusText.textContent = srvOnline ? 'ONLINE' : 'OFFLINE';
  serverStatusText.className = `status-value ${srvOnline ? 'text-green' : 'text-red'}`;
  serverDot.className = `dot ${srvOnline ? 'dot-green' : 'dot-red'}`;

  if (snapshot.serverInfo) {
    const ver = snapshot.serverInfo.version || '-';
    const players = `${snapshot.serverInfo.playersOnline || 0}/${snapshot.serverInfo.playersMax || 0}`;
    serverSubtext.textContent = srvOnline
      ? `Version: ${ver} • Players: ${players}`
      : `Aternos Server is Offline`;
  }

  // 2. BOT STATUS (CONNECTED, DISCONNECTED, CONNECTING)
  const bStatus = snapshot.botStatus || 'DISCONNECTED';
  botStatusText.textContent = bStatus;

  if (bStatus === 'CONNECTED') {
    botStatusText.className = 'status-value text-green';
    botDot.className = 'dot dot-green';
  } else if (bStatus === 'CONNECTING') {
    botStatusText.className = 'status-value text-amber';
    botDot.className = 'dot dot-amber';
  } else {
    botStatusText.className = 'status-value text-red';
    botDot.className = 'dot dot-red';
  }

  if (snapshot.config) {
    serverAddressEl.textContent = `${snapshot.config.host}:${snapshot.config.port} • ${snapshot.config.username}`;
    botSubtext.textContent = `Username: ${snapshot.config.username}`;
  }

  // 3. UPTIME & RECONNECT COUNTDOWN
  uptimeText.textContent = bStatus === 'CONNECTED' ? formatHMS(snapshot.uptimeSeconds) : '00:00:00';

  if (bStatus === 'DISCONNECTED' && snapshot.isReconnecting && snapshot.reconnectCountdown > 0) {
    reconnectSubtext.textContent = `Auto-reconnecting in ${snapshot.reconnectCountdown}s...`;
  } else if (bStatus === 'CONNECTED') {
    reconnectSubtext.textContent = 'Bot is active on server';
  } else {
    reconnectSubtext.textContent = 'Counts only real connected time';
  }

  // 4. BUTTON STATES (Prevent duplicate connections)
  btnStart.disabled = bStatus === 'CONNECTED' || bStatus === 'CONNECTING';
  btnStop.disabled = bStatus === 'DISCONNECTED' && !snapshot.isReconnecting;
  toggleAutoReconnect.checked = Boolean(snapshot.autoReconnect);

  // 5. LIVE CONSOLE LOGS
  renderLogs(snapshot.logs);
}

async function postAction(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data && data.snapshot) {
    applySnapshot(data.snapshot);
  }
  return data;
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  try {
    await postAction('/api/start');
  } catch (err) {
    btnStart.disabled = false;
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    await postAction('/api/stop');
  } catch (err) {
    btnStop.disabled = false;
  }
});

btnRefreshPing.addEventListener('click', async () => {
  try {
    await postAction('/api/ping-server');
  } catch (_) {}
});

toggleAutoReconnect.addEventListener('change', async () => {
  try {
    await postAction('/api/autoreconnect', { enabled: toggleAutoReconnect.checked });
  } catch (_) {}
});

btnClearLogs.addEventListener('click', async () => {
  lastLogCount = -1;
  try {
    await postAction('/api/logs/clear');
  } catch (_) {}
});

// Connect to real-time Server-Sent Events (SSE) stream
function connectLiveStream() {
  const evtSource = new EventSource('/api/stream');

  evtSource.addEventListener('state', (e) => {
    streamIndicator.textContent = 'LIVE SSE';
    streamIndicator.style.color = '#22c55e';
    try {
      const snapshot = JSON.parse(e.data);
      applySnapshot(snapshot);
    } catch (_) {}
  });

  evtSource.onerror = () => {
    streamIndicator.textContent = 'RECONNECTING SSE';
    streamIndicator.style.color = '#f59e0b';
  };
}

// Initial fetch + live SSE stream
fetch('/api/status')
  .then((r) => r.json())
  .then(applySnapshot)
  .catch(() => {});

connectLiveStream();
```

### (7) `.replit`
```toml
run = "npm start"
entrypoint = "server.js"
modules = ["nodejs-20"]

[env]
PORT = "3000"

[[ports]]
localPort = 3000
externalPort = 80
```

## 4. Replit और Android Termux पर चलाने और टेस्ट करने का तरीका (सरल हिंदी में)

### तरीका A: Replit पर कैसे चलाएँ
1. अपने Replit अकाउंट में एक नया **Node.js Repl** बनाएँ (या `tomato-smp-bot.zip` अपलोड करें)।
2. मुख्य फोल्डर में `package.json`, `server.js`, `bot.js`, और `.replit` रखें, तथा `public/` फोल्डर बनाकर उसमें `index.html`, `style.css`, और `script.js` रखें।
3. Replit के Shell में यह कमांड चलाएँ:
   ```bash
   npm install
   npm start
   ```
4. ऊपर **Run** बटन दबाएँ। Replit अपने आप `process.env.PORT` (3000) पर **TOMATO SMP BOT** वेबसाइट खोल देगा।

### तरीका B: कैसे टेस्ट करें (How to Verify Real Status)
* **टेस्ट 1 (जब आपका Aternos सर्वर बंद/Offline हो):** डैशबोर्ड खोलें और **START BOT** दबाएँ। `bot.js` असली TCP पिंग करेगा और देखेगा कि Aternos सर्वर बंद है। **SERVER STATUS** तुरंत `OFFLINE` (लाल) दिखेगा, **BOT STATUS** `DISCONNECTED` रहेगा, अपटाइम `00:00:00` रहेगा, और कंसोल में असली एरर (`Cannot connect bot: Server TomatoSMP.aternos.me:35074 is OFFLINE`) आएगा। कोई फेक ऑनलाइन स्टेटस नहीं दिखेगा।
* **टेस्ट 2 (जब आपका Aternos सर्वर चालू/Online हो):** Aternos पर अपना सर्वर (`TomatoSMP.aternos.me:35074`) चालू करें और सुनिश्चित करें कि Aternos Options में **Cracked (Offline Mode)** ऑन है। अब **Check Server** या **START BOT** दबाएँ:
  * **SERVER STATUS** बदलकर हरा **`ONLINE`** हो जाएगा और वर्शन व प्लेयर काउंट दिखाएगा।
  * **BOT STATUS** पहले पीला **`CONNECTING`** दिखेगा, और जब `TomatoAFK` सर्वर में लॉगिन और स्पॉन हो जाएगा, तभी हरा **`CONNECTED`** दिखेगा और अपटाइम काउंटर (`00:00:00`) चलना शुरू होगा।
