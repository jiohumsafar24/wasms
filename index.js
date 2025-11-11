const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { Boom } = require('@hapi/boom');

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const AUTH_DIR = path.join(__dirname, 'auth');

// ✅ SAFE sessions file handling
let sessions = {};
try {
  fs.ensureDirSync(AUTH_DIR);
  if (fs.existsSync(SESSIONS_FILE)) {
    const content = fs.readFileSync(SESSIONS_FILE, 'utf8').trim();
    sessions = content ? JSON.parse(content) : {};
  } else {
    fs.writeJsonSync(SESSIONS_FILE, {});
  }
} catch (err) {
  console.error('Error reading sessions file:', err.message);
  sessions = {};
  fs.writeJsonSync(SESSIONS_FILE, {});
}

const autoReplies = {};
const regexTriggers = {};
const regexTriggersPro = {};
const sockets = {};

function formatNumber(num) {
  const clean = num.toString().replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(clean)) return null;
  return `${clean}@s.whatsapp.net`;
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ HEALTH CHECK ENDPOINT (Add this at top)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API',
    version: '1.0.0',
    sessions: Object.keys(sessions).length,
    activeConnections: Object.values(sockets).filter(s => s.isConnected).length,
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      createSession: 'POST /api/v1/session/:sessionId',
      getQR: 'GET /api/v1/session/:sessionId/qr',
      status: 'GET /api/v1/session/:sessionId/status'
    }
  });
});

// ✅ ADDITIONAL HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    sessions: Object.keys(sessions).length
  });
});

app.get('/whatsapp/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API - Plesk Subdirectory',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length
  });
});

function verifyApiKey(req, res, next) {
  const apiKey = req.header('Authorization')?.replace('Bearer ', '');
  const { sessionId } = req.params;
  if (!apiKey || sessions[sessionId] !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ✅ FIXED: Safe file write function
async function safeWriteSessions() {
  try {
    await fs.writeJson(SESSIONS_FILE, sessions, { spaces: 2 });
    return true;
  } catch (err) {
    console.error('Error writing sessions:', err.message);
    return false;
  }
}

async function connectSession(sessionId) {
  try {
    const authPath = path.join(AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    // ✅ FIXED: Proper socket cleanup
    if (sockets[sessionId]) {
      if (sockets[sessionId].isConnected) {
        console.log(`[${sessionId}] ♻️ Already connected, skipping new init`);
        return sockets[sessionId];
      } else {
        console.log(`[${sessionId}] ♻️ Stale socket found, replacing...`);
        try {
          delete sockets[sessionId];
        } catch (e) {
          console.error(`[${sessionId}] Cleanup error:`, e.message);
        }
      }
    }

    const sock = makeWASocket({ 
      auth: state,
      printQRInTerminal: true, // ✅ Terminal pe QR dikhaye
      keepAliveIntervalMs: 10000
    });

    sock.isConnected = false;
    sock.sessionId = sessionId; // ✅ Session ID add karo
    sockets[sessionId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code Received`);
        sock.lastQR = qr; // ✅ Store raw QR data
      }

      if (connection === 'open') {
        sock.isConnected = true;
        sock.lastQR = null; // ✅ Clear QR after connection
        console.log(`[${sessionId}] ✅ WhatsApp connected`);

        // 🔁 Load configurations
        const autoReplyPath = path.join(authPath, 'autoReplies.json');
        if (fs.existsSync(autoReplyPath)) {
          autoReplies[sessionId] = await fs.readJson(autoReplyPath);
          console.log(`[${sessionId}] 🔁 Loaded autoReplies`);
        } else {
          autoReplies[sessionId] = [];
        }

        const regexTriggerPath = path.join(authPath, 'regexTriggers.json');
        if (fs.existsSync(regexTriggerPath)) {
          regexTriggers[sessionId] = await fs.readJson(regexTriggerPath);
          console.log(`[${sessionId}] 🔁 Loaded regexTriggers`);
        } else {
          regexTriggers[sessionId] = [];
        }

        const regexTriggerProPath = path.join(authPath, 'regexTriggersPro.json');
        if (fs.existsSync(regexTriggerProPath)) {
          regexTriggersPro[sessionId] = await fs.readJson(regexTriggerProPath);
          console.log(`[${sessionId}] 🔁 Loaded regexTriggersPro`);
        } else {
          regexTriggersPro[sessionId] = [];
        }
      }

      if (connection === 'close') {
        sock.isConnected = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`[${sessionId}] ⚠️ Disconnected:`, reason);

        if (reason === DisconnectReason.loggedOut) {
          console.log(`[${sessionId}] ❌ Logged out. Cleaning up...`);
          try {
            await fs.remove(authPath);
          } catch (e) {
            console.error(`[${sessionId}] Cleanup error:`, e.message);
          }
        } else {
          console.log(`[${sessionId}] 🔄 Reconnecting in 5s...`);
          setTimeout(() => connectSession(sessionId), 5000);
        }
      }
    });

    // 📩 Message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages?.[0]) return;
      const msg = messages[0];
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!text) return;

      // ✅ RegexTriggersPro
      const proTriggers = regexTriggersPro[sessionId] || [];
      for (const trigger of proTriggers) {
        try {
          const regex = new RegExp(trigger.regex, 'i');
          const allowedNumbers = trigger.target_number
            .split(',')
            .map(num => formatNumber(num.trim()))
            .filter(Boolean);

          if (!allowedNumbers.includes(from)) continue;

          if (regex.test(text)) {
            const match = text.match(regex);
            const keyword = match?.[0];

            const payload = {
              keyword,
              name: trigger.name,
              pattern: trigger.regex
            };

            try {
              const res = await axios.post(trigger.callback_url, payload, { timeout: 10000 });
              const replyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
              await sock.sendMessage(from, { text: replyText });
            } catch (err) {
              console.error(`[${sessionId}] ❌ Pro Trigger Callback Error:`, err.message);
              await sock.sendMessage(from, { text: '❌ Error processing your request.' });
            }
            break;
          }
        } catch (err) {
          console.error(`[${sessionId}] ❌ Invalid regexPro pattern: ${trigger.regex}`, err.message);
        }
      }

      // ✅ Auto Replies
      const replies = autoReplies[sessionId] || [];
      const lowerText = text.toLowerCase().trim();

      for (const { keyword, reply } of replies) {
        const cleanedText = lowerText.replace(/[^a-z0-9]/gi, '');
        const cleanedKeyword = keyword.replace(/[^a-z0-9]/gi, '');
        if (cleanedText === cleanedKeyword) {
          await new Promise(r => setTimeout(r, 1500));
          await sock.sendMessage(from, { text: reply });
          return;
        }
      }

      // ✅ Regex Triggers
      const triggers = regexTriggers[sessionId] || [];
      const matchedTriggers = [];

      for (const trigger of triggers) {
        try {
          const regex = new RegExp(trigger.regex, 'i');
          if (regex.test(text)) {
            matchedTriggers.push(trigger);
          }
        } catch (err) {
          console.error(`[${sessionId}] ❌ Regex error in pattern "${trigger.regex}":`, err.message);
        }
      }

      if (matchedTriggers.length > 0) {
        const bestMatch = matchedTriggers.reduce((a, b) =>
          b.regex.length > a.regex.length ? b : a
        );

        try {
          const regex = new RegExp(bestMatch.regex, 'i');
          const match = text.match(regex);
          const keyword = match[0];

          const payload = {
            keyword: keyword,
            name: bestMatch.name,
            pattern: bestMatch.regex
          };

          const res = await axios.post(bestMatch.callback_url, payload, { timeout: 10000 });
          const replyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
          await sock.sendMessage(from, { text: replyText });
        } catch (err) {
          console.error(`[${sessionId}] ❌ Callback error:`, err.message);
          await sock.sendMessage(from, {
            text: '❌ Error processing your request. Please try again.'
          });
        }
        return;
      }
    });

    return sock;
  } catch (error) {
    console.error(`[${sessionId}] ❌ Connection error:`, error.message);
    throw error;
  }
}

// ✅ FIXED: Create session with safe write
app.post('/api/v1/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  sessions[sessionId] = apiKey;
  const success = await safeWriteSessions();

  if (success) {
    return res.json({ success: true, sessionId, apiKey });
  } else {
    return res.status(500).json({ error: 'Failed to save session' });
  }
});

// ✅ FIXED: QR Code with better error handling
app.get('/api/v1/session/:sessionId/qr', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;

  try {
    if (!sockets[sessionId]) {
      await connectSession(sessionId);
    }

    if (sockets[sessionId].isConnected) {
      return res.json({ connected: true });
    }

    const qr = sockets[sessionId].lastQR;
    if (!qr) {
      return res.status(503).json({ 
        status: 'waiting', 
        message: 'QR not yet generated. Please wait...' 
      });
    }

    // ✅ Generate QR image
    const qrImage = await QRCode.toDataURL(qr);
    return res.json({ connected: false, qr: qrImage });

  } catch (error) {
    console.error(`[${sessionId}] QR Error:`, error.message);
    return res.status(500).json({ 
      error: 'Failed to generate QR code',
      message: error.message 
    });
  }
});

app.get('/api/v1/session/:sessionId/status', verifyApiKey, (req, res) => {
  const sock = sockets[req.params.sessionId];
  return res.json({ 
    connected: sock?.isConnected || false,
    sessionId: req.params.sessionId
  });
});

// ✅ Text Message
app.post('/api/v1/session/:sessionId/sendText', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'Not connected' });

  const jid = formatNumber(to);
  if (!jid) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(jid, { text });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// Other API endpoints (same as your code, just ensure error handling)
// ... [Rest of your API endpoints remain the same]

// ✅ FIXED: Auto reconnect with error handling
(async () => {
  console.log('🔁 Auto reconnecting sessions on startup...');
  const storedSessions = Object.keys(sessions);
  
  for (const sessionId of storedSessions) {
    console.log(`[${sessionId}] Attempting reconnect...`);
    try {
      await connectSession(sessionId);
      console.log(`[${sessionId}] ✅ Reconnected successfully`);
    } catch (err) {
      console.error(`[${sessionId}] ❌ Failed to reconnect:`, err.message);
    }
    // Add delay between reconnections
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
})();

// 🔊 Start Server
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 WhatsApp API Service Started`);
  console.log(`🔧 Health Check: http://localhost:${PORT}/health`);
  console.log(`🌐 Plesk URL: https://example.com/whatsapp/`);
});
