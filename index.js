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

fs.ensureDirSync(AUTH_DIR);
if (!fs.existsSync(SESSIONS_FILE)) fs.writeJsonSync(SESSIONS_FILE, {});
const sessions = fs.readJsonSync(SESSIONS_FILE);

const autoReplies = {};
const regexTriggers = {}; // ✅ regexTriggers storage
const regexTriggersPro = {}; // 🔁 Just like regexTriggers
const sockets = {};

function formatNumber(num) {
  const clean = num.toString().replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(clean)) return null;
  return `${clean}@s.whatsapp.net`;
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ HEALTH CHECK ENDPOINTS ADDED
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API',
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

app.get('/whatsapp/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'WhatsApp API - Plesk',
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

async function connectSession(sessionId) {
  const authPath = path.join(AUTH_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  if (sockets[sessionId]) {
  if (sockets[sessionId].isConnected) {
    console.log(`[${sessionId}] ♻️ Already connected, skipping new init`);
    return sockets[sessionId];
  } else {
    console.log(`[${sessionId}] ♻️ Stale socket found, replacing...`);
    delete sockets[sessionId]; // logout ke bina naya connection allow karo
  }
}

  const sock = makeWASocket({ 
    auth: state,
    keepAliveIntervalMs: 10000 // ✅ har 10s me ping bhejega
  });

  sock.isConnected = false;
  sockets[sessionId] = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) sock.lastQR = qr;

    if (connection === 'open') {
      sock.isConnected = true;
      console.log(`[${sessionId}] ✅ WhatsApp connected`);

      // 🔁 Load autoReplies
      const autoReplyPath = path.join(authPath, 'autoReplies.json');
      if (fs.existsSync(autoReplyPath)) {
        autoReplies[sessionId] = await fs.readJson(autoReplyPath);
        console.log(`[${sessionId}] 🔁 Loaded autoReplies`);
      } else {
        autoReplies[sessionId] = [];
      }

      // 🔁 Load regexTriggers
      const regexTriggerPath = path.join(authPath, 'regexTriggers.json');
      if (fs.existsSync(regexTriggerPath)) {
        regexTriggers[sessionId] = await fs.readJson(regexTriggerPath);
        console.log(`[${sessionId}]  Loaded regexTriggers`);
      } else {
        regexTriggers[sessionId] = [];
      }

      //  Load regexTriggersPro
      const regexTriggerProPath = path.join(authPath, 'regexTriggersPro.json');
      if (fs.existsSync(regexTriggerProPath)) {
        regexTriggersPro[sessionId] = await fs.readJson(regexTriggerProPath);
        console.log(`[${sessionId}] Loaded regexTriggersPro`);
      } else {
        regexTriggersPro[sessionId] = [];
      }
    }

    if (connection === 'close') {
      sock.isConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[${sessionId}] ⚠️ Disconnected:`, reason);

      if (reason === DisconnectReason.loggedOut) {
        console.log(`[${sessionId}] ❌ Logged out. Please scan QR again.`);
      } else {
        console.log(`[${sessionId}] 🔄 Reconnecting in 5s...`);
        setTimeout(() => connectSession(sessionId), 5000);
      }
    }
  });

  // 📩 Message handler as before (aapka existing code yaha rehna chahiye)
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
}

app.post('/api/v1/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

  sessions[sessionId] = apiKey;
  await fs.writeJson(SESSIONS_FILE, sessions, { spaces: 2 });

  return res.json({ success: true, sessionId, apiKey });
});

app.get('/api/v1/session/:sessionId/qr', verifyApiKey, async (req, res) => {
  const { sessionId } = req.params;

  if (!sockets[sessionId]) {
    await connectSession(sessionId);
  }

  if (sockets[sessionId].isConnected) {
    return res.json({ connected: true });
  }

  const qr = sockets[sessionId].lastQR;
  if (!qr) {
    return res.status(503).json({ status: 'waiting', message: 'QR not yet generated' });
  }

  const qrImage = await QRCode.toDataURL(qr);
  return res.json({ connected: false, qr: qrImage });
});

app.get('/api/v1/session/:sessionId/status', verifyApiKey, (req, res) => {
  const sock = sockets[req.params.sessionId];
  return res.json({ connected: sock?.isConnected || false });
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


//  Send Image (URL or base64) with optional caption
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


//  Send PDF/Doc with optional caption
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

//  Send Location
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

// 🔁 Reconnect (safe reconnect, no logout)
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

    // 👇 reconnect attempt kare bina logout kiye
    console.log(`[${sessionId}] 🔄 Reconnecting safely...`);
    await connectSession(sessionId);

    return res.json({ success: true, message: 'Reconnected successfully' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.toString() });
  }
});


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
    return res.json({ success: true, triggers: [] }); // Optional fallback
  }
});


// ✅ 1. Set Disappearing Messages
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


// ✅ 2. Check if number exists on WhatsApp + name, profilePic, businessName
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
      name = await sock.fetchName(jid); // ✅ fetch display name
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

//  GET autoReplies
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


//  Auto reconnect sessions on server start
(async () => {
  const storedSessions = fs.readJsonSync(SESSIONS_FILE);
  for (const sessionId of Object.keys(storedSessions)) {
    console.log(`[${sessionId}]  Auto reconnecting on startup...`);
    try {
      await connectSession(sessionId);
      console.log(`[${sessionId}] ✅ Reconnected successfully`);
    } catch (err) {
      console.error(`[${sessionId}] ❌ Failed to reconnect:`, err.message);
    }
  }
})();

// 🔊 Start Server
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔧 Health Check: http://localhost:${PORT}/health`);
  console.log(`🌐 Render URL: https://wasms-f81r.onrender.com/health`);
});
