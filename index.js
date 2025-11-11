const express = require('express');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

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

// ✅ HEALTH CHECK ENDPOINTS
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API - Complete Features',
    sessions: Object.keys(sessions).length,
    activeConnections: Object.values(sockets).filter(s => s.isConnected).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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

// ✅ FIXED: WhatsApp connection with PROPER device linking
async function connectSession(sessionId) {
  try {
    console.log(`[${sessionId}] 🔄 Initializing WhatsApp connection...`);
    
    const authPath = path.join(AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    // ✅ Latest version fetch for compatibility
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      // ✅ PROPER logger to avoid issues
      logger: pino({ level: 'silent' }),
      // ✅ Better browser configuration
      browser: Browsers.ubuntu('Chrome'),
      // ✅ Mobile device linking ke liye important settings
      markOnlineOnConnect: false, // ✅ Yeh line important hai
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      // ✅ Connection settings
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      // ✅ Mobile companion mode
      mobile: false,
      getMessage: async (key) => {
        return {
          conversation: "hello"
        }
      }
    });

    sock.isConnected = false;
    sock.sessionId = sessionId;
    sock.lastQR = null;
    sockets[sessionId] = sock;

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log(`[${sessionId}] Connection update:`, connection);

      // ✅ QR Code generation
      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code received - Scan with WhatsApp Mobile`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          sock.lastQR = qrImage;
          console.log(`[${sessionId}] ✅ QR Code generated successfully`);
          
          // ✅ Terminal mein QR code display
          QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
            if (!err) {
              console.log(`[${sessionId}] Scan this QR code:`);
              console.log(url);
            }
          });
        } catch (error) {
          console.error(`[${sessionId}] ❌ QR generation error:`, error.message);
        }
      }

      if (connection === 'open') {
        sock.isConnected = true;
        sock.lastQR = null;
        console.log(`[${sessionId}] ✅ WhatsApp connected successfully!`);
        console.log(`[${sessionId}] 📱 Device properly linked with mobile`);

        // Load configurations
        try {
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
            console.log(`[${sessionId}]  Loaded regexTriggers`);
          } else {
            regexTriggers[sessionId] = [];
          }

          const regexTriggerProPath = path.join(authPath, 'regexTriggersPro.json');
          if (fs.existsSync(regexTriggerProPath)) {
            regexTriggersPro[sessionId] = await fs.readJson(regexTriggerProPath);
            console.log(`[${sessionId}] Loaded regexTriggersPro`);
          } else {
            regexTriggersPro[sessionId] = [];
          }
        } catch (error) {
          console.error(`[${sessionId}] ❌ Error loading configs:`, error.message);
        }
      }

      if (connection === 'close') {
        sock.isConnected = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`[${sessionId}] ⚠️ Disconnected:`, reason);

        if (reason === DisconnectReason.loggedOut || reason === 401) {
          console.log(`[${sessionId}] ❌ Logged out - clearing auth data`);
          try {
            await fs.remove(authPath);
            console.log(`[${sessionId}] ✅ Auth data cleared`);
          } catch (e) {
            console.error(`[${sessionId}] Error clearing auth:`, e.message);
          }
          
          // Fresh connection after 3 seconds
          setTimeout(() => {
            console.log(`[${sessionId}] 🔄 Starting fresh connection after logout`);
            connectSession(sessionId);
          }, 3000);
        } else {
          console.log(`[${sessionId}] 🔄 Reconnecting in 5s...`);
          setTimeout(() => connectSession(sessionId), 5000);
        }
      }
    });

    // ✅ COMPLETE Message handler (sare features ke saath)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages?.[0]) return;
      const msg = messages[0];
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!text) return;

      console.log(`[${sessionId}] 📩 Message from ${from}: ${text}`);

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
              const res = await axios.post(trigger.callback_url, payload);
              const replyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
              await sock.sendMessage(from, { text: replyText });
            } catch (err) {
              console.error(`[${sessionId}] ❌ Pro Trigger Callback Error:`, err.message);
              await sock.sendMessage(from, { text: '❌ Error processing your request.' });
            }

            break; // Stop after one match
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

// ✅ API ROUTES - ALL FEATURES INCLUDED

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

// ✅ QR Code API
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

    // Wait for QR code
    let qrFound = false;
    for (let i = 0; i < 30; i++) {
      if (sock.lastQR) {
        qrFound = true;
        return res.json({
          success: true,
          connected: false,
          qr: sock.lastQR,
          message: 'Scan QR code with WhatsApp Mobile'
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

// ✅ Text Message
app.post('/api/v1/session/:sessionId/sendText', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, text } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'Not connected' });

  const jid = formatNumber(to);
  if (!jid) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await new Promise(r => setTimeout(r, 1500)); // Delay to mimic human
    await sock.sendMessage(jid, { text });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// ✅ Send Image (URL or base64) with optional caption
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

// ✅ Auto Replies (store in auth/<sessionId>/autoReplies.json)
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

// ✅ Send PDF/Doc with optional caption
app.post('/api/v1/session/:sessionId/sendDocument', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, document, mimetype, filename, caption } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'not connected' });

  try {
    await sock.sendMessage(`${to}@s.whatsapp.net`, {
      document: { url: document },
      fileName: filename || 'file.pdf',
      mimetype: mimetype || 'application/pdf',
      caption: caption || ''
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// ✅ Send Location
app.post('/api/v1/session/:sessionId/sendLocation', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, latitude, longitude, name } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'not connected' });

  const jid = formatNumber(to);
  if (!jid) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await sock.sendMessage(jid, {
      location: {
        degreesLatitude: parseFloat(latitude),
        degreesLongitude: parseFloat(longitude),
        name: name || 'Shared Location'
      }
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// ✅ Reconnect (safe reconnect, no logout)
app.post('/api/v1/session/:sessionId/reconnect', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;

  try {
    const sock = sockets[sessionId];

    if (!sock) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    if (sock.isConnected) {
      return res.json({ success: true, message: 'Already connected' });
    }

    console.log(`[${sessionId}] 🔄 Reconnecting safely...`);
    await connectSession(sessionId);

    return res.json({ success: true, message: 'Reconnected successfully' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.toString() });
  }
});

// ✅ RegexTriggersPro
app.post('/api/v1/session/:sessionId/regexTriggersPro', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { triggers } = req.body;

  if (!Array.isArray(triggers)) {
    return res.status(400).json({ error: 'triggers must be an array' });
  }

  for (const trigger of triggers) {
    if (!trigger.name || !trigger.regex || !trigger.callback_url || !trigger.target_number) {
      return res.status(400).json({ error: 'Each trigger must include name, regex, callback_url, and target_number' });
    }
  }

  const filePath = path.join(AUTH_DIR, sessionId, 'regexTriggersPro.json');
  await fs.writeJson(filePath, triggers, { spaces: 2 });
  regexTriggersPro[sessionId] = triggers;

  return res.json({ success: true, count: triggers.length });
});

app.get('/api/v1/session/:sessionId/regexTriggersPro', verifyApiKey, async (req, res) => {
  const filePath = path.join(AUTH_DIR, req.params.sessionId, 'regexTriggersPro.json');
  if (fs.existsSync(filePath)) {
    const triggers = await fs.readJson(filePath);
    return res.json({ success: true, triggers });
  } else {
    return res.json({ success: true, triggers: [] });
  }
});

// ✅ Set Disappearing Messages
app.post('/api/v1/session/:sessionId/setDisappearing', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { to, duration } = req.body;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'Not connected' });

  const jid = formatNumber(to);
  if (!jid || ![0, 86400, 604800, 7776000].includes(duration)) {
    return res.status(400).json({ error: 'Invalid number or duration' });
  }

  try {
    await sock.sendMessage(jid, { disappearingMessagesInChat: duration });
    return res.json({ success: true, message: `Set disappearing message for ${duration}s` });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// ✅ Check if number exists on WhatsApp + name, profilePic, businessName
app.get('/api/v1/session/:sessionId/checkNumber', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;
  const { number } = req.query;

  const sock = sockets[sessionId];
  if (!sock?.isConnected) return res.status(409).json({ error: 'Not connected' });

  const jid = formatNumber(number);
  if (!jid) return res.status(400).json({ error: 'Invalid number' });

  try {
    const result = await sock.onWhatsApp(jid);
    const exists = result?.[0]?.exists || false;

    let profilePic = null;
    try {
      profilePic = await sock.profilePictureUrl(jid, 'image');
    } catch {} // ignore privacy errors

    let businessName = null;
    try {
      const biz = await sock.getBusinessProfile(jid);
      businessName = biz?.businessProfile?.name || null;
    } catch {}

    let name = null;
    try {
      name = await sock.fetchName(jid);
    } catch {}

    return res.json({
      exists,
      jid,
      name,
      profilePic,
      businessName
    });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// ✅ Delete session
app.delete('/api/v1/session/:sessionId', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;

  if (sockets[sessionId]) {
    await sockets[sessionId].logout();
    delete sockets[sessionId];
  }

  delete sessions[sessionId];
  await fs.writeJson(SESSIONS_FILE, sessions, { spaces: 2 });

  const sessionAuthPath = path.join(AUTH_DIR, sessionId);
  if (fs.existsSync(sessionAuthPath)) {
    await fs.remove(sessionAuthPath);
  }

  return res.json({ success: true });
});

// ✅ RegexTriggers
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

// ✅ GET autoReplies
app.get('/api/v1/session/:sessionId/autoReplies', verifyApiKey, async (req, res) => {
  const filePath = path.join(AUTH_DIR, req.params.sessionId, 'autoReplies.json');
  if (fs.existsSync(filePath)) {
    const replies = await fs.readJson(filePath);
    return res.json({ success: true, data: replies });
  } else {
    return res.status(404).json({ error: 'autoReplies.json not found' });
  }
});

// ✅ GET regexTriggers
app.get('/api/v1/session/:sessionId/regexTriggers', verifyApiKey, async (req, res) => {
  const filePath = path.join(AUTH_DIR, req.params.sessionId, 'regexTriggers.json');
  if (fs.existsSync(filePath)) {
    const triggers = await fs.readJson(filePath);
    return res.json({ success: true, data: triggers });
  } else {
    return res.status(404).json({ error: 'regexTriggers.json not found' });
  }
});

// ✅ Auto reconnect sessions on server start
async function autoReconnectSessions() {
  console.log('🔁 Auto-reconnecting existing sessions...');
  const sessionIds = Object.keys(sessions);
  
  if (sessionIds.length === 0) {
    console.log('ℹ️ No existing sessions found for auto-reconnect');
    return;
  }

  for (const sessionId of sessionIds) {
    try {
      console.log(`[${sessionId}] Auto reconnecting on startup...`);
      await connectSession(sessionId);
      console.log(`[${sessionId}] ✅ Reconnected successfully`);
    } catch (err) {
      console.error(`[${sessionId}] ❌ Failed to reconnect:`, err.message);
    }
  }
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp API - Complete Features + Device Linking Fix`);
  console.log(`🔧 Health: http://localhost:${PORT}/health`);
  
  // Auto-reconnect after delay
  setTimeout(autoReconnectSessions, 3000);
});
