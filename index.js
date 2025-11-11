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

// ✅ SAFE sessions file handling (Pehle code se)
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

// ✅ HEALTH CHECK ENDPOINTS (Dusre code se)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API - Baileys 6.4.0',
    sessions: Object.keys(sessions).length,
    activeConnections: Object.values(sockets).filter(s => s.isConnected).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API',
    baileysVersion: '6.4.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    sessions: Object.keys(sessions).length,
    activeConnections: Object.values(sockets).filter(s => s.isConnected).length
  });
});

app.get('/whatsapp/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API - Plesk',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length
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

// ✅ SAFE file write function (Pehle code se)
async function safeWriteSessions() {
  try {
    await fs.writeJson(SESSIONS_FILE, sessions, { spaces: 2 });
    return true;
  } catch (err) {
    console.error('Error writing sessions:', err.message);
    return false;
  }
}

// ✅ FIXED: WhatsApp connection with PROPER QR GENERATION (Pehle code se)
async function connectSession(sessionId) {
  try {
    console.log(`[${sessionId}] 🔄 Initializing WhatsApp connection...`);
    
    const authPath = path.join(AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true, // ✅ Yehi line QR code ke liye important hai
      browser: ['Ubuntu', 'Chrome', '110.0.5481.100'],
      markOnlineOnConnect: false
    });

    sock.isConnected = false;
    sock.sessionId = sessionId;
    sock.lastQR = null; // ✅ Initialize lastQR
    sockets[sessionId] = sock;

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // ✅ PROPER QR Code generation (Pehle code se)
      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code received`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          sock.lastQR = qrImage; // ✅ Store QR image
          console.log(`[${sessionId}] ✅ QR Code generated successfully`);
        } catch (error) {
          console.error(`[${sessionId}] ❌ QR generation error:`, error.message);
        }
      }

      if (connection === 'open') {
        sock.isConnected = true;
        sock.lastQR = null;
        console.log(`[${sessionId}] ✅ WhatsApp connected successfully!`);

        // Load configurations
        try {
          const autoReplyPath = path.join(authPath, 'autoReplies.json');
          if (fs.existsSync(autoReplyPath)) {
            autoReplies[sessionId] = await fs.readJson(autoReplyPath);
          }

          const regexTriggerPath = path.join(authPath, 'regexTriggers.json');
          if (fs.existsSync(regexTriggerPath)) {
            regexTriggers[sessionId] = await fs.readJson(regexTriggerPath);
          }

          const regexTriggerProPath = path.join(authPath, 'regexTriggersPro.json');
          if (fs.existsSync(regexTriggerProPath)) {
            regexTriggersPro[sessionId] = await fs.readJson(regexTriggerProPath);
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
          console.log(`[${sessionId}] ❌ Logged out`);
        } else {
          console.log(`[${sessionId}] 🔄 Reconnecting in 10s...`);
          setTimeout(() => connectSession(sessionId), 10000);
        }
      }
    });

    // Handle incoming messages (Dusre code se)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages?.[0]) return;
      
      const msg = messages[0];
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

      if (!text) return;

      console.log(`[${sessionId}] 📩 Message from ${from}: ${text}`);

      // ✅ RegexTriggersPro (Dusre code se)
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
              const res = await axios.post(trigger.callback_url, payload);
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

      // Process auto-replies
      const replies = autoReplies[sessionId] || [];
      const lowerText = text.toLowerCase().trim();

      for (const { keyword, reply } of replies) {
        const cleanedText = lowerText.replace(/[^a-z0-9]/gi, '');
        const cleanedKeyword = keyword.toLowerCase().replace(/[^a-z0-9]/gi, '');
        
        if (cleanedText === cleanedKeyword) {
          try {
            await sock.sendMessage(from, { text: reply });
          } catch (error) {
            console.error(`[${sessionId}] ❌ Auto-reply error:`, error.message);
          }
          return;
        }
      }

      // ✅ Regex Triggers (Dusre code se)
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

          const res = await axios.post(bestMatch.callback_url, payload);
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

    console.log(`[${sessionId}] ✅ WhatsApp client initialized`);
    return sock;

  } catch (error) {
    console.error(`[${sessionId}] ❌ Connection error:`, error.message);
    throw error;
  }
}

// ✅ API ROUTES

// Create session
app.post('/api/v1/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { apiKey } = req.body;
  
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }

  try {
    sessions[sessionId] = apiKey;
    await safeWriteSessions();
    
    res.json({ 
      success: true, 
      sessionId, 
      apiKey,
      message: 'Session created successfully' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ FIXED: QR Code API (Pehle code se - jo work karta hai)
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

    // Wait for QR code (Pehle code ka logic)
    let qrFound = false;
    for (let i = 0; i < 60; i++) {
      if (sock.lastQR) {
        qrFound = true;
        return res.json({
          success: true,
          connected: false,
          qr: sock.lastQR,
          message: 'Scan QR code with WhatsApp'
        });
      }
      
      // Check if connected while waiting
      if (sock.isConnected) {
        return res.json({ 
          success: true, 
          connected: true,
          message: 'Connected to WhatsApp!' 
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Timeout
    if (!qrFound) {
      res.status(408).json({
        success: false,
        error: 'QR generation timeout',
        message: 'Please try again'
      });
    }

  } catch (error) {
    console.error(`[${sessionId}] QR API error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to generate QR code'
    });
  }
});

// Check status
app.get('/api/v1/session/:sessionId/status', verifyApiKey, (req, res) => {
  const { sessionId } = req.params;
  const sock = sockets[sessionId];
  
  res.json({
    success: true,
    connected: sock?.isConnected || false,
    sessionId: sessionId
  });
});

// Send text message
app.post('/api/v1/session/:sessionId/sendText', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;

  const sock = sockets[sessionId];
  if (!sock) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!sock.isConnected) {
    return res.status(409).json({ error: 'Not connected to WhatsApp' });
  }

  try {
    const jid = formatNumber(to);
    if (!jid) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    await sock.sendMessage(jid, { text });
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ Baaki sab endpoints dusre code se (jo work karte hain)
// Send Image
app.post('/api/v1/session/:sessionId/sendImage', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, image, caption } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'not connected' });

  try {
    await sock.sendMessage(`${to}@s.whatsapp.net`, {
      image: { url: image },
      caption: caption || ''
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// Auto Replies
app.post('/api/v1/session/:sessionId/autoReplies', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { replies, saveToAuth } = req.body;

  if (!Array.isArray(replies)) {
    return res.status(400).json({ error: 'replies must be an array' });
  }

  const formattedReplies = replies.map(r => ({
    keyword: r.keyword.toLowerCase(),
    reply: r.reply
  }));

  autoReplies[sessionId] = formattedReplies;

  if (saveToAuth) {
    const filePath = path.join(AUTH_DIR, sessionId, 'autoReplies.json');
    await fs.writeJson(filePath, formattedReplies, { spaces: 2 });
    console.log(`[${sessionId}] 💾 AutoReplies saved to ${filePath}`);
  }

  return res.json({ success: true, count: formattedReplies.length });
});

// GET autoReplies
app.get('/api/v1/session/:sessionId/autoReplies', verifyApiKey, async (req, res) => {
  const filePath = path.join(AUTH_DIR, req.params.sessionId, 'autoReplies.json');
  if (fs.existsSync(filePath)) {
    const replies = await fs.readJson(filePath);
    return res.json({ success: true, data: replies });
  } else {
    return res.status(404).json({ error: 'autoReplies.json not found' });
  }
});

// Regex Triggers
app.post('/api/v1/session/:sessionId/regexTriggers', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { triggers } = req.body;

  if (!Array.isArray(triggers)) {
    return res.status(400).json({ error: 'triggers must be an array' });
  }

  for (const trigger of triggers) {
    if (!trigger.name || !trigger.regex || !trigger.callback_url) {
      return res.status(400).json({ error: 'Each trigger must include name, regex, and callback_url' });
    }
  }

  const filePath = path.join(AUTH_DIR, sessionId, 'regexTriggers.json');
  await fs.writeJson(filePath, triggers, { spaces: 2 });
  regexTriggers[sessionId] = triggers;

  return res.json({ success: true, count: triggers.length });
});

app.get('/api/v1/session/:sessionId/regexTriggers', verifyApiKey, async (req, res) => {
  const filePath = path.join(AUTH_DIR, req.params.sessionId, 'regexTriggers.json');
  if (fs.existsSync(filePath)) {
    const triggers = await fs.readJson(filePath);
    return res.json({ success: true, data: triggers });
  } else {
    return res.status(404).json({ error: 'regexTriggers.json not found' });
  }
});

// ✅ Auto reconnect on startup
async function autoReconnectSessions() {
  console.log('🔁 Auto-reconnecting existing sessions...');
  const sessionIds = Object.keys(sessions);
  
  if (sessionIds.length === 0) {
    console.log('ℹ️ No existing sessions found for auto-reconnect');
    return;
  }

  for (const sessionId of sessionIds) {
    try {
      console.log(`[${sessionId}] Attempting reconnect...`);
      await connectSession(sessionId);
      console.log(`[[${sessionId}] ✅ Reconnected successfully`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (error) {
      console.error(`[${sessionId}] ❌ Reconnect failed:`, error.message);
    }
  }
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp API with Baileys 6.4.0 (Stable Version)`);
  console.log(`🔧 Health: http://localhost:${PORT}/health`);
  console.log(`🌐 Render: https://wasms-f81r.onrender.com/health`);
  
  // Auto-reconnect after delay
  setTimeout(autoReconnectSessions, 3000);
});
