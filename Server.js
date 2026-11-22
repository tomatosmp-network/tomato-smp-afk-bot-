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
         
