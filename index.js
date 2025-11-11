const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ✅ HEALTH CHECK ENDPOINTS (ADDED)
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

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API',
    baileysVersion: '6.7.18',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`,
      heap: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
    },
    sessions: Object.keys(sessions).length,
    activeConnections: Object.values(sockets).filter(s => s.isConnected).length
  });
});

function verifyApiKey(req, res, next) {
  const apiKey = req.header('Authorization')?.replace('Bearer ', '') || req.query.apiKey;
  const { sessionId } = req.params;
  if (!apiKey || sessions[sessionId] !== apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ✅ SAFE file write function
async function safeWriteSessions() {
  try {
    await fs.writeJson(SESSIONS_FILE, sessions, { spaces: 2 });
    return true;
  } catch (err) {
    console.error('Error writing sessions:', err.message);
    return false;
  }
}

// ✅ FIXED: WhatsApp connection for Baileys 6.7.18
async function connectSession(sessionId) {
  try {
    console.log(`[${sessionId}] 🔄 Initializing WhatsApp connection...`);
    
    const authPath = path.join(AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      // ✅ Baileys 6.7.18 compatible configuration
      logger: {
        level: 'fatal' // Only fatal errors show karega
      },
      browser: ['Ubuntu', 'Chrome', '110.0.5481.100'],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60000
    });

    sock.isConnected = false;
    sock.sessionId = sessionId;
    sockets[sessionId] = sock;

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // ✅ FIXED: QR Code generation for Baileys 6.7.18
      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code received`);
        try {
          const qrImage = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 300,
            color: {
              dark: '#000000',
              light: '#FFFFFF'
            }
          });
          sock.lastQR = qrImage;
          console.log(`[${sessionId}] ✅ QR Code generated successfully`);
        } catch (error) {
          console.error(`[${sessionId}] ❌ QR generation error:`, error.message);
        }
      }

      if (connection === 'open') {
        sock.isConnected = true;
        sock.lastQR = null; // Clear QR after connection
        console.log(`[${sessionId}] ✅ WhatsApp connected`);

        // 🔁 Load configurations
        try {
          const autoReplyPath = path.join(authPath, 'autoReplies.json');
          if (fs.existsSync(autoReplyPath)) {
            autoReplies[sessionId] = await fs.readJson(autoReplyPath);
            console.log(`[${sessionId}] 🔁 Loaded autoReplies`);
          }

          const regexTriggerPath = path.join(authPath, 'regexTriggers.json');
          if (fs.existsSync(regexTriggerPath)) {
            regexTriggers[sessionId] = await fs.readJson(regexTriggerPath);
            console.log(`[${sessionId}] 🔁 Loaded regexTriggers`);
          }

          const regexTriggerProPath = path.join(authPath, 'regexTriggersPro.json');
          if (fs.existsSync(regexTriggerProPath)) {
            regexTriggersPro[sessionId] = await fs.readJson(regexTriggerProPath);
            console.log(`[${sessionId}] 🔁 Loaded regexTriggersPro`);
          }
        } catch (error) {
          console.error(`[${sessionId}] ❌ Error loading configs:`, error.message);
        }
      }

      if (connection === 'close') {
        sock.isConnected = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`[${sessionId}] ⚠️ Disconnected:`, reason);

        if (reason === DisconnectReason.loggedOut) {
          console.log(`[${sessionId}] ❌ Logged out. Please scan QR again.`);
          try {
            await fs.remove(authPath);
          } catch (e) {
            console.error(`[${sessionId}] Cleanup error:`, e.message);
          }
        } else {
          console.log(`[${sessionId}] 🔄 Reconnecting in 10s...`);
          setTimeout(() => connectSession(sessionId), 10000);
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

// ✅ FIXED: QR Code API with better handling
app.get('/api/v1/session/:sessionId/qr', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;

  try {
    let sock = sockets[sessionId];
    
    // Check if already connected
    if (sock?.isConnected) {
      return res.json({ 
        success: true, 
        connected: true,
        message: 'Already connected to WhatsApp' 
      });
    }

    // Initialize new connection if not exists
    if (!sock) {
      sock = await connectSession(sessionId);
    }

    // Wait for QR code with longer timeout for Render.com
    let qrFound = false;
    for (let i = 0; i < 60; i++) { // 60 seconds timeout
      if (sock.lastQR) {
        qrFound = true;
        return res.json({ 
          connected: false, 
          qr: sock.lastQR,
          message: 'Scan QR code with WhatsApp'
        });
      }
      
      // Check if connected while waiting
      if (sock.isConnected) {
        return res.json({ connected: true });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Timeout
    if (!qrFound) {
      return res.status(408).json({ 
        status: 'timeout', 
        message: 'QR generation timeout. Render.com free tier might be slow.' 
      });
    }

  } catch (error) {
    console.error(`[${sessionId}] QR API error:`, error.message);
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

// ... (Rest of your API endpoints remain the same)

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
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
})();

// 🔊 Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp API Service Started`);
  console.log(`🔧 Health Check: http://localhost:${PORT}/health`);
  console.log(`🌐 Render URL: https://wasms-f81r.onrender.com/health`);
});
