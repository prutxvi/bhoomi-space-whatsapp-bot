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
- Chat naturally. Don't sound like a bot. Be warm and helpful.
- First message ALWAYS: "Hello! How can I help you today?" — NEVER ask about budget or property first.
- Let the person tell YOU what they want. Don't assume.

INTENT HANDLING (understand what they want before acting):
1. BUYER — they mention budget, BHK, want to buy/visit. → Suggest matching properties, offer site visit.
2. SELLER — "I want to sell", "need to sell my flat/house". → Ask: area, BHK, expected price, name, phone. Say "I'll have our agent contact you about selling."
3. PRICE CHECK — "What are rates in Gachibowli?" → Give general info. No push.
4. RENTER — "Looking for rental." → "We mainly handle sales. I can ask our agent to suggest rentals."
5. BROWSER — no clear intent → Answer briefly, don't push.

AVAILABLE PROPERTIES (for BUYERS only):
🏠 Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready, Gachibowli
🏠 Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready, Tellapur
🏠 Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready, Tellapur
🏠 KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready, Gachibowli
🏠 My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026, Kokapet
🏠 Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027, Nallagandla
🏠 Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet

RULES:
- Keep replies 2-3 lines. WhatsApp style, not email.
- NEVER offer images or brochures. Say "I'll have our agent share details."
- When a BUYER asks to visit, say: "Perfect! Let me take your details for the booking."
- When a SELLER shares their details, say: "Thanks! Our agent will contact you soon."
- Use Telugu/English mix naturally with Telugu speakers.
- IMPORTANT: Remember the conversation. If they said they're a seller, don't ask them to buy later.`;

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

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Sri Sai Properties', '', ''],
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !qrShown) {
      qrShown = true;
      fs.writeFileSync(__dirname + '/qr.txt', qr);
      console.log('\n' + '='.repeat(55));
      console.log('  SCAN THIS QR WITH YOUR WHATSAPP SPARE NUMBER');
      console.log('  WhatsApp -> Settings -> Linked Devices -> Link a Device');
      console.log('='.repeat(55) + '\n');
      qrcode.generate(qr, { small: false });
      console.log('\n' + '='.repeat(55));
      console.log('  Waiting for scan...');
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
      const langMap = { '1': 'telugu', '2': 'english', '3': 'hindi', 'telugu': 'telugu', 'english': 'english', 'hindi': 'hindi', 'te': 'telugu', 'en': 'english', 'hi': 'hindi' };
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
http.createServer((req, res) => {
  const qrFile = __dirname + '/qr.txt';
  const qrPng = __dirname + '/qr.png';
  if (req.url === '/qr' && fs.existsSync(qrFile)) {
    const qrData = fs.readFileSync(qrFile, 'utf8').trim();
    if (qrData) {
      QR.toFile(qrPng, qrData, { width: 500, margin: 2, color: { dark: '#000', light: '#fff' }, errorCorrectionLevel: 'L' }, (err) => {
        if (err) { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('QR error'); return; }
        const img = fs.readFileSync(qrPng);
        const b64 = img.toString('base64');
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>setTimeout(function(){location.reload()},15000)</script><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif;text-align:center;flex-direction:column;padding:20px}.card{background:#fff;padding:16px;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.08);max-width:340px}img{width:100%;max-width:280px;display:block;margin:0 auto}h3{color:#222;margin:15px 0 5px;font-size:15px}p{color:#666;font-size:13px;margin:3px 0}.bad{background:#e8f5e9;padding:4px 10px;border-radius:20px;font-size:12px;color:#2e7d32;display:inline-block;margin-top:10px}</style></head><body><div class="card"><img src="data:image/png;base64,${b64}"/><h3>Scan with WhatsApp</h3><p>Open WhatsApp → Linked Devices → Link a Device</p><p style="font-size:11px;color:#999;margin-top:8px">Auto-refreshes every 15s · ${new Date().toLocaleTimeString()}</p></div></body></html>`);
      });
      return;
    }
  }
  res.writeHead(200, {'Content-Type': 'text/html'});
  if (req.url === '/qr') res.end('QR generating... Refresh.');
  else res.end('OK');
}).listen(PORT, () => console.log(`Server on ${PORT}`));

startBot();
