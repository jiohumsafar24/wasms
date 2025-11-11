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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ✅ HEALTH CHECK
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
    baileysVersion: '6.4.0',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length
  });
});

// API Key Verification
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

// ✅ FIXED: WhatsApp connection for Baileys 6.4.0
async function connectSession(sessionId) {
  try {
    console.log(`[${sessionId}] 🔄 Initializing WhatsApp connection...`);
    
    const authPath = path.join(AUTH_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true, // ✅ 6.4.0 mein yeh work karta hai
      logger: {
        level: 'fatal' // ✅ Only fatal errors show karega
      },
      browser: ['Ubuntu', 'Chrome', '110.0.5481.100'],
      markOnlineOnConnect: false
    });

    sock.isConnected = false;
    sock.sessionId = sessionId;
    sockets[sessionId] = sock;

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // ✅ QR Code generation - FIXED
      if (qr) {
        console.log(`[${sessionId}] 📱 QR Code received`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          sock.lastQR = qrImage;
          console.log(`[${sessionId}] ✅ QR Code generated successfully`);
        } catch (error) {
          console.error(`[${sessionId}] ❌ QR generation error:`, error.message);
        }
      }

      // Connection opened
      if (connection === 'open') {
        sock.isConnected = true;
        sock.lastQR = null;
        console.log(`[${sessionId}] ✅ WhatsApp connected successfully!`);
      }

      // Connection closed
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

// ✅ FIXED: QR Code API
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

    // Wait for QR code (longer timeout for Render.com)
    let qrFound = false;
    for (let i = 0; i < 60; i++) { // 60 seconds timeout
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
        message: 'Render.com free tier might be slow. Please try again.'
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WhatsApp API with Baileys 6.4.0 (Fixed Version)`);
  console.log(`🌐 Health: https://wasms-f81r.onrender.com/health`);
});
