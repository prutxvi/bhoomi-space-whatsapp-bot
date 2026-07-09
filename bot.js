require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are "Sri Sai Properties" — a professional real estate WhatsApp assistant in Hyderabad.

HOW TO BEHAVE:
- Chat naturally. Sound like a helpful local agent, not a bot.
- First message ALWAYS: "Hello! How can I help you today?" — NEVER ask about budget or property first.
- Let the person tell YOU what they want. Don't assume.

FORMATTING RULES (CRITICAL):
- NEVER send more than 3 lines per message.
- When suggesting properties, use ONE line per property like this:
  🏠 Aparna Elita — 2BHK, 1280 sqft, ₹89L — Gachibowli (Ready)
  🏠 Lodha Meridian — 2BHK, 1150 sqft, ₹78L — Tellapur (Ready)
- Then ask ONE question at the end.
- No paragraphs. No long descriptions. WhatsApp style.
- Use emojis: 🏠 for properties, ✅ for confirmations, 📞 for contact.

INTENT HANDLING:
1. BUYER — mentions budget/BHK/wants to buy. → Suggest 2-3 matching properties in bullet format. Ask "Want to visit?"
2. SELLER — "I want to sell". → Ask: area, BHK, expected price, name, phone.
3. PRICE CHECK — "Rates in Gachibowli?" → "2BHK from ₹78L, 3BHK from ₹1.45Cr in that area."
4. RENTER — "Looking for rental." → "We mainly handle sales. Want me to ask our agent about rentals?"
5. BROWSER — no clear intent → Answer briefly. Don't push.

AVAILABLE PROPERTIES:
🏠 Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready, Gachibowli
🏠 Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready, Tellapur
🏠 Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready, Tellapur
🏠 KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready, Gachibowli
🏠 My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026, Kokapet
🏠 Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027, Nallagandla
🏠 Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet

RULES:
- Keep replies 2-3 lines max. ONE question per message.
- NEVER send paragraphs or walls of text — WhatsApp style only.
- NEVER offer images. Say "I'll have our agent share details."
- When buyer wants to visit: Ask for name AND phone. Don't confirm until you have both.
- When seller shares property details: Ask for name AND phone before confirming.
- Remember the conversation. If they said they're a seller earlier, don't ask them to buy now.
- Use Telugu/English mix naturally with Telugu speakers.`;

let conversationMemory = new Map();
const MEMORY_FILE = __dirname + '/memory.json';
try { const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); conversationMemory = new Map(Object.entries(saved)); } catch(e) {}
const AGENT_JID = process.env.AGENT_NUMBER || '';
const MAX_HISTORY = 10;

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(conversationMemory)));
}

async function sendMsg(sock, jid, msg) {
  try { await sock.sendMessage(jid, msg); } catch (e) { console.log('Send error:', e.message); }
}

async function getAIReply(userMessage, lang = 'english', history = []) {
  const langInstruction = lang === 'telugu' ? 'IMPORTANT: Always reply in TELUGU (తెలుగు). Use Telugu script. Be natural.'
    : lang === 'hindi' ? 'IMPORTANT: Always reply in HINDI (हिंदी). Use Devanagari script. Be natural.'
    : 'IMPORTANT: Reply in ENGLISH. Be conversational.';
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n' + langInstruction },
      ...history.slice(-MAX_HISTORY),
      { role: 'user', content: userMessage }
    ];
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 300
    });
    return completion.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('Groq API error:', e.message);
    return null;
  }
}

function hasSellerInfo(text) {
  const lower = text.toLowerCase();
  return lower.includes('sell') || lower.includes('selling') || lower.includes('sale') || lower.includes('listing');
}

function hasPhone(text) {
  return /\d{10}/.test(text.replace(/[^0-9]/g, ''));
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  let qrShown = false;
  let pairingRequested = false;

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Sri Sai Properties', '', ''],
  });

  global.__sock = sock;

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    global.__sock = sock;
    if (qr && !qrShown) {
      qrShown = true;
      fs.writeFileSync(__dirname + '/qr.txt', qr);
      global.__qr_data = qr;
      console.log('\n' + '='.repeat(55));
      console.log('  OPTION 1: SCAN QR WITH WHATSAPP');
      console.log('  WhatsApp -> Settings -> Linked Devices -> Link a Device');
      console.log('='.repeat(55) + '\n');
      qrcode.generate(qr, { small: false });
      console.log('\n' + '='.repeat(55));
      console.log('  OPTION 2: USE PAIRING CODE');
      console.log('  Visit /pair?phone=91XXXXXXXXXX in browser');
      console.log('  Enter the code in WhatsApp -> Linked Devices');
      console.log('='.repeat(55) + '\n');
    }
    if (connection === 'open') {
      console.log('\n✅ BOT IS LIVE!\n');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        qrShown = false;
        startBot();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.remoteJid;
    if (!text) return;

    const phone = sender.split('@')[0];
    const conv = conversationMemory.get(sender) || { count: 0, flow: null, step: 0, data: {}, messages: [] };
    conv.count = (conv.count || 0) + 1;
    const lower = text.toLowerCase().trim();

    let reply = '';

    // --- Booking Form Flow ---
    if (conv.flow === 'booking') {
      if (conv.step === 0) {
        conv.data.name = text.trim();
        conv.step = 1;
        reply = `Thanks ${conv.data.name}! And your phone number?`;
      } else if (conv.step === 1) {
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length >= 10) {
          conv.data.phone = cleaned.slice(-10);
          conv.step = 2;
          reply = `Perfect! When would work best for you? Morning, afternoon, or evening — and which day?`;
        } else {
          reply = `Please share a 10-digit number so our agent can reach you.`;
        }
      } else if (conv.step === 2) {
        conv.data.time = text.trim();
        conv.step = 3;
        reply = `Got it! Any specific property you're interested in, or shall our agent suggest options?`;
      } else if (conv.step === 3) {
        conv.data.property = text.trim();
        conv.step = 4;
        reply = `Anything specific you'd like the agent to know? (Or say "no")`;
      } else if (conv.step === 4) {
        conv.data.notes = text.trim().toLowerCase() === 'no' ? '' : text.trim();
        const leadMsg = `🔔 *New Booking!*\n👤 ${conv.data.name}\n📱 ${conv.data.phone}\n📅 ${conv.data.time}\n🏠 ${conv.data.property}\n📝 ${conv.data.notes || '—'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        try { await sock.sendMessage(AGENT_JID, { text: leadMsg }); } catch(e) {}
        reply = `You're all set ${conv.data.name}! 🎉 Our agent will confirm your slot shortly.`;
        conv.flow = null; conv.step = 0; conv.data = {};
        conversationMemory.set(sender, conv); saveMemory();
        await sendMsg(sock, sender, { text: reply });
        return;
      }
      conversationMemory.set(sender, conv); saveMemory();
      await sendMsg(sock, sender, { text: reply });
      return;
    }

    // --- Language Selection ---
    if (!conv.lang) {
      const langMap = { '1': 'telugu', '2': 'english', '3': 'hindi', 'telugu': 'telugu', 'english': 'english', 'hindi': 'hindi' };
      const chosen = langMap[lower] || '';
      if (chosen) {
        conv.lang = chosen;
        conversationMemory.set(sender, conv); saveMemory();
        reply = chosen === 'telugu' ? 'Namaste! Sri Sai Properties. Meeru em kavali?'
             : chosen === 'hindi' ? 'Namaste! Sri Sai Properties. Aapko kya chahiye?'
             : 'Hello! Sri Sai Properties. How can I help you today?';
        await sendMsg(sock, sender, { text: reply });
        return;
      }
      reply = `*Welcome to Sri Sai Properties!* 🏡 Please choose your language:\n\n1️⃣ Telugu\n2️⃣ English\n3️⃣ Hindi`;
      await sendMsg(sock, sender, { text: reply });
      return;
    }

    // --- AI Response with Memory ---
    try {
      reply = await getAIReply(text, conv.lang || 'english', conv.messages || []);
    } catch (e) {
      console.log(`Groq error: ${e.message}`);
    }

    if (!reply) {
      if (['hi', 'hello', 'hey', 'namaste'].includes(lower)) {
        reply = conv.lang === 'telugu' ? 'Namaste! Sri Sai Properties. Meeru em kavali?'
             : conv.lang === 'hindi' ? 'Namaste! Sri Sai Properties. Aapko kya chahiye?'
             : 'Hello! Sri Sai Properties. How can I help you today?';
      } else if (lower.includes('agent') || lower.includes('call')) {
        reply = conv.lang === 'telugu' ? 'Maa agent call chestaru. Time cheppandi.'
             : conv.lang === 'hindi' ? 'Humara agent call karega. Time batao.'
             : 'Our agent will call you. Share your preferred time?';
      } else if (lower.includes('thank')) {
        reply = 'You\'re welcome! Let me know if you need anything else.';
      } else {
        reply = conv.lang === 'telugu' ? 'Telugu lo cheppandi. Nenu help chestanu.'
             : conv.lang === 'hindi' ? 'Kya aapko madad chahiye?'
             : 'How can I help you today?';
      }
    }

    // --- Store in Memory ---
    if (!conv.messages) conv.messages = [];
    conv.messages.push({ role: 'user', content: text });
    conv.messages.push({ role: 'assistant', content: reply });
    if (conv.messages.length > MAX_HISTORY * 2) {
      conv.messages = conv.messages.slice(-MAX_HISTORY * 2);
    }

    await sendMsg(sock, sender, { text: reply });
    console.log(`✅ ${phone}: "${text.slice(0,35)}"`);

    // --- Forward Booking/Seller Leads ---
    const userHasPhone = /\b[6-9]\d{9}\b/.test(text);
    const convText = conv.messages.map(m => m.content).join(' ').toLowerCase();
    const isBookingConv = convText.includes('visit') || convText.includes('book') || convText.includes('site');
    const isSellerConv = hasSellerInfo(convText) && userHasPhone;

    if (userHasPhone && (isBookingConv || isSellerConv)) {
      const leadType = isSellerConv ? 'Seller Lead' : 'Booking Lead';
      const leadMsg = `🔔 *New ${leadType}!*\n📱 ${phone}\n💬 "${text.slice(0,150)}"\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
      try { await sock.sendMessage(AGENT_JID, { text: leadMsg }); } catch(e) {}
      console.log(`📤 ${leadType} forwarded: ${phone}`);
    }

    conversationMemory.set(sender, conv);
    saveMemory();
  });
}

// HTTP server for Railway
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qrFile = __dirname + '/qr.txt';

  // --- Pairing Code Endpoint ---
  if (url.pathname === '/pair') {
    const phone = url.searchParams.get('phone');
    if (!phone) {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:16px;font-family:sans-serif}input,button{font-size:18px;padding:10px;border:2px solid #ddd;border-radius:8px}button{background:#25D366;color:#fff;border:none;cursor:pointer}form{display:flex;gap:10px;max-width:400px;flex-wrap:wrap}</style></head><body><h3>WhatsApp Pairing</h3><form method="get" action="/pair"><input type="tel" name="phone" placeholder="91XXXXXXXXXX" required/><button type="submit">Get Code</button></form><p style="margin-top:12px;color:#666;font-size:13px">Enter your WhatsApp number with country code (without +)</p></body></html>`);
      return;
    }
    try {
      const sock = global.__sock;
      if (!sock) { res.end('Bot not ready. Wait 10 seconds and refresh.'); return; }
      const code = await sock.requestPairingCode(phone);
      const display = typeof code === 'string' ? code.match(/.{1,4}/g)?.join('-') || code : code;
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f0faf0;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif;text-align:center;flex-direction:column;padding:20px}.card{background:#fff;padding:30px;border-radius:16px;box-shadow:0 2px 24px rgba(0,0,0,.1);max-width:400px}.code{font-size:42px;font-weight:700;letter-spacing:6px;color:#075e54;background:#e8f5e9;padding:20px;border-radius:12px;margin:15px 0;font-family:monospace}.step{color:#333;font-size:15px;margin:6px 0}.num{color:#999;font-size:13px;margin-top:15px}</style></head><body><div class="card"><h2 style="color:#075e54">Pairing Code</h2><div class="code">${display}</div><p class="step">1️⃣ Open WhatsApp on your phone</p><p class="step">2️⃣ Settings → <b>Linked Devices</b></p><p class="step">3️⃣ Tap <b>Link a Device</b></p><p class="step">4️⃣ Enter this code</p><p class="num">Phone: ${phone} · Code expires in 2 minutes</p></div></body></html>`);
    } catch (e) {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`Error: ${e.message}. Try again in 10 seconds.`);
    }
    return;
  }

  // --- QR Endpoint ---
  if (url.pathname === '/qr' && fs.existsSync(qrFile)) {
    const qrData = fs.readFileSync(qrFile, 'utf8').trim();
    if (qrData) {
      QR.toString(qrData, { type: 'utf8', errorCorrectionLevel: 'L' }, (err, str) => {
        if (err) { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('QR error'); return; }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:5px}pre{font-size:8px;line-height:1;letter-spacing:0;font-family:monospace;margin:0;padding:4px}</style></head><body><pre>${str}</pre></body></html>`);
      });
      return;
    }
  }
  res.writeHead(200, {'Content-Type': 'text/html'});
  if (url.pathname === '/qr') res.end('QR generating... Refresh.');
  else res.end('OK');
}).listen(PORT, () => console.log(`Server on ${PORT}`));

startBot();
