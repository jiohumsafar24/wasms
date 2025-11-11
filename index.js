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
    service: 'WhatsApp API - Fixed Device Linking',
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
    console.log(`[${sessionId}] Using Baileys version: ${version}, isLatest: ${isLatest}`);

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
      // ✅ Retry settings
      maxRetries: 3,
      // ✅ Security settings
      fireInitQueries: true,
      transactionOpts: {
        maxCommitRetries: 3,
        delayBetweenTriesMs: 3000
      },
      // ✅ Mobile companion mode (Yeh line fix karegi device linking)
      mobile: false, // Desktop device ke liye
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
      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

      console.log(`[${sessionId}] Connection update:`, {
        connection,
        qr: !!qr,
        isNewLogin,
        receivedPendingNotifications
      });

      // ✅ QR Code generation
      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code received - Scan with WhatsApp Mobile`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          sock.lastQR = qrImage;
          console.log(`[${sessionId}] ✅ QR Code generated successfully`);
          
          // ✅ Terminal mein QR code display (optional)
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

        if (reason === DisconnectReason.loggedOut || reason === 401) {
          console.log(`[${sessionId}] ❌ Logged out - clearing auth data`);
          // Clear auth data and restart fresh
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

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !messages?.[0]) return;
      
      const msg = messages[0];
      if (msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

      if (!text) return;

      console.log(`[${sessionId}] 📩 Message from ${from}: ${text}`);

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

// ✅ Auto reconnect with better error handling
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
      
      // Check if auth directory exists and is valid
      const authPath = path.join(AUTH_DIR, sessionId);
      if (!fs.existsSync(authPath)) {
        console.log(`[${sessionId}] No auth data found, skipping reconnect`);
        continue;
      }
      
      await connectSession(sessionId);
      console.log(`[${sessionId}] ✅ Reconnected successfully`);
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
  console.log(`📱 WhatsApp API - Fixed Device Linking Issue`);
  console.log(`🔧 Health: http://localhost:${PORT}/health`);
  
  // Auto-reconnect after delay
  setTimeout(autoReconnectSessions, 3000);
});
