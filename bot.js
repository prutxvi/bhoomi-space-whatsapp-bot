require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const PROPERTY_IMAGES = {
  'Aparna Elita':        __dirname + '/images/aparna-elita.jpg',
  'Lodha Meridian':      __dirname + '/images/lodha-meridian.jpg',
  'Prestige High Fields':__dirname + '/images/prestige-high-fields.jpg',
  'KNR Greenville':      __dirname + '/images/knr-greenville.jpg',
  'My Home Vihanga':     __dirname + '/images/my-home-vihanga.jpg',
  'Rajapushpa Provincia':__dirname + '/images/rajapushpa-provincia.jpg',
  'Godrej Ananda':       __dirname + '/images/godrej-ananda.jpg',
  'Sai Residency':       __dirname + '/images/sai-residency.jpg',
  'Sri Lakshmi Towers':  __dirname + '/images/sri-lakshmi-towers.jpg',
  'Vishnu Heights':      __dirname + '/images/vishnu-heights.jpg',
};

const SYSTEM_PROMPT = `You are "Sri Sai Properties" — a real estate WhatsApp assistant in Hyderabad.

BEHAVE NATURALLY:
- Be friendly and helpful like a local agent.
- One short question at a time. No paragraphs.
- First message: "Hello! How can I help you today?" — Never ask budget first.

CONVERSATION GUIDE:
- If they greet → Ask what they need
- If they want a property → Ask buying or renting, then budget and area
- Suggest 2-3 matching properties from the list below with details
- After suggesting, ask if they want photos (only send if they ask)
- If they want to visit → Ask for their name and phone naturally
- If they ask about an area → Describe it simply
- If they want to sell → Ask area, BHK, expected price, name and phone

IMPORTANT:
- Never list all properties at once. Only 2-3 matching their budget.
- Never write long paragraphs. Short WhatsApp-style messages.
- Ask one thing at a time. Don't overwhelm.
- Use emojis naturally: 🏠 for properties, ✅ for confirm, 📸 for images.
- If they ask for photos, offer to share. Then ask if they want to visit.
- Remember what they said. Don't repeat questions.

AVAILABLE PROPERTIES:
🏠 Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready, Gachibowli
🏠 Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready, Tellapur
🏠 Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready, Tellapur
🏠 KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready, Gachibowli
🏠 My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026, Kokapet
🏠 Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027, Nallagandla
🏠 Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet
🏠 Sai Residency — 2BHK, 1050 sqft, ₹68L, Ready, Kondapur
🏠 Sri Lakshmi Towers — 3BHK, 1550 sqft, ₹1.25Cr, Aug 2026, Manikonda
🏠 Vishnu Heights — 2BHK, 1100 sqft, ₹72L, Ready, Miyapur

BUDGET RANGES (use these to match):
- Under ₹80L: Sai Residency, Vishnu Heights
- ₹80L-₹1Cr: Aparna Elita, Lodha Meridian, Prestige High Fields, KNR Greenville
- ₹1Cr-₹2Cr: My Home Vihanga, Godrej Ananda, Rajapushpa Provincia, Sri Lakshmi Towers
- Over ₹2Cr: Rajapushpa Provincia, Godrej Ananda

AREA INFO:
- Gachibowli: IT hub, 2BHK from ₹78L, good for families
- Kokapet: Premium area, 3BHK from ₹1.45Cr
- Tellapur: Affordable, 2BHK from ₹78L, upcoming area
- Nallagandla: New development, connected to ORR`;

let conversationMemory = new Map();
const MEMORY_FILE = __dirname + '/memory.json';
try { const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); conversationMemory = new Map(Object.entries(saved)); } catch(e) {}
const AGENT_JID = process.env.AGENT_NUMBER || '';
const MAX_HISTORY = 10;

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(conversationMemory)));
}

async function sendMsg(sock, jid, msg) {
  try {
    await sock.sendMessage(jid, msg);
    return true;
  } catch (e) { console.log('Send error:', e.message); return false; }
}

async function getAIReply(userMessage, lang = 'english', history = []) {
  const langInstruction = lang === 'telugu' ? 'IMPORTANT: Always reply in TELUGU (తెలుగు). Use Telugu script. Be natural.'
    : lang === 'hindi' ? 'IMPORTANT: Always reply in HINDI (हिंदी). Use Devanagari script. Be natural.'
    : 'IMPORTANT: Reply in ENGLISH. Be conversational.';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + '\n' + langInstruction },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: userMessage }
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.7,
        max_tokens: 300
      });
      return completion.choices[0]?.message?.content || '';
    } catch (e) {
      if (attempt === 0) {
        console.log('Groq retrying...');
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      console.log('Groq API error:', e.message);
      return null;
    }
  }
}

function hasSellerInfo(text) {
  const lower = text.toLowerCase();
  return lower.includes('sell') || lower.includes('selling') || lower.includes('sale') || lower.includes('listing');
}

function findPhone(text) {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length >= 11) {
    const stripped = digits.replace(/^(?:\+|00)?(?:91)?0?/, '');
    if (stripped.length === 10 && /^[6-9]/.test(stripped)) return stripped;
    if (stripped.length > 10) {
      const trimmed = stripped.slice(0, 10);
      if (trimmed.length === 10 && /^[6-9]/.test(trimmed)) return trimmed;
    }
  }
  return null;
}

function __(lang, en, te, hi) {
  if (lang === 'telugu') return te;
  if (lang === 'hindi') return hi;
  return en;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  let qrShown = false;

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'warn' }),
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
      try { fs.unlinkSync(__dirname + '/qr.txt'); } catch(e) {}
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        qrShown = false;
        startBot();
      } else {
        console.log('\n❌ BOT LOGGED OUT! Scan QR again to restart.\n');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.remoteJid;
    const phone = sender.split('@')[0];

    // Handle non-text messages
    if (!text) {
      if (msg.message.imageMessage) {
        text = '[Image]';
      } else if (msg.message.audioMessage || msg.message.pttMessage) {
        text = '[Voice]';
      } else if (msg.message.videoMessage) {
        text = '[Video]';
      } else if (msg.message.locationMessage) {
        text = '[Location]';
      } else if (msg.message.documentMessage) {
        text = '[Document]';
      } else if (msg.message.stickerMessage) {
        text = '[Sticker]';
      } else {
        return;
      }
      const lang = (conversationMemory.get(sender) || {}).lang || 'english';
      const replies = {
        '[Image]': { telugu: 'Meeeru oka photo pampincharu. Meeru elaanti property kosam chustunnaru?', english: 'I see you sent a photo! What type of property are you looking for?', hindi: 'Aapne ek photo bheja hai. Aap kaise property dhundh rahe hain?' },
        '[Voice]': { telugu: 'Meeeru voice message pampincharu. Dayachesi text lo cheppandi.', english: 'I got your voice message. Could you type what you need?', hindi: 'Aapne voice message bheja hai. Kripya text mein bataen.' },
        '[Video]': { telugu: 'Video chusanu. Property gurinchi text lo cheppandi.', english: 'Thanks for the video! Tell me about the property you\'re looking for.', hindi: 'Video dekha. Property ke baare mein text mein bataen.' },
        '[Location]': { telugu: 'Location chusanu. Aa area lo elaanti property kavali?', english: 'Got your location! What type of property are you looking for in this area?', hindi: 'Location mil gayi! Is area mein kaise property chahiye?' },
        '[Document]': { telugu: 'Document pampincharu. Nenu real estate lo help chestanu.', english: 'Thanks for the document! How can I help you with properties?', hindi: 'Document mil gaya. Property mein kaise madad chahiye?' },
        '[Sticker]': { telugu: '😂😊', english: '😂😊 Need help finding a property?', hindi: '😂😊 Property dhundhne mein madad chahiye?' },
      };
      const r = (replies[text] || {})[lang] || replies[text]?.english || 'How can I help you?';
      await sock.sendMessage(sender, { text: r });
      return;
    }
    const conv = conversationMemory.get(sender) || { count: 0, messages: [], sentImages: [], lang: undefined };
    conv.count = (conv.count || 0) + 1;
    const lower = text.toLowerCase().trim();

    let reply = '';

    // --- Language Selection ---
    if (!conv.lang || ['language', 'change language', 'switch language', 'lang'].includes(lower)) {
      if (['language', 'change language', 'switch language', 'lang'].includes(lower)) {
        conv.lang = undefined;
      }
      const langMap = { '1': 'telugu', '2': 'english', '3': 'hindi', 'telugu': 'telugu', 'english': 'english', 'hindi': 'hindi' };
      const chosen = langMap[lower] || '';
      if (chosen) {
        conv.lang = chosen;
        conversationMemory.set(sender, conv); saveMemory();
        reply = chosen === 'telugu' ? 'Namaskaram! Sri Sai Properties. Meeku emi sahayam kavali?'
             : chosen === 'hindi' ? 'Namaste! Sri Sai Properties. Main aapki kaise madad kar sakta hoon?'
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
      if (['hi', 'hello', 'hey', 'namaste'].some(w => lower.startsWith(w) || lower.includes(' ' + w))) {
        reply = conv.lang === 'telugu' ? 'Namaskaram! Sri Sai Properties. Meeku emi sahayam kavali?'
             : conv.lang === 'hindi' ? 'Namaste! Sri Sai Properties. Main aapki kaise madad kar sakta hoon?'
             : 'Hello! Sri Sai Properties. How can I help you today?';
      } else if (lower.includes('agent') || lower.includes('call')) {
        reply = conv.lang === 'telugu' ? 'Maa agent call chestaru. Time cheppandi.'
             : conv.lang === 'hindi' ? 'Humara agent call karega. Time batao.'
             : 'Our agent will call you. Share your preferred time?';
      } else if (lower.includes('thank')) {
        reply = __(conv.lang, 'You\'re welcome! Let me know if you need anything else.',
                         'Mee svagatham! Miku inkem kavali ante cheppandi.',
                         'Aapka swagat hai! Kya aur koi madad chahiye?');
      } else {
        reply = conv.lang === 'telugu' ? 'Kshaminchandi, naku konni samasya vunnayi. Dayachesi malli cheppandi.'
             : conv.lang === 'hindi' ? 'Maaf karo, kuch technical problem hai. Kya aap dubara bata sakte hain?'
             : 'Sorry, I\'m having a glitch. Can you repeat that?';
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

    // --- Send Property Images (only when user asks) ---
    const needsImage = /\b(images?|photos?|pictures?|pic?s?|show|see|look|brochure)\b/i.test(text.toLowerCase());
    if (needsImage) {
      if (!conv.sentImages) conv.sentImages = [];
      await sock.sendPresenceUpdate('composing', sender).catch(() => {});
      for (const [propName, imgPath] of Object.entries(PROPERTY_IMAGES)) {
        if (conv.sentImages.includes(propName)) continue;
        const mentionedInReply = reply.toLowerCase().includes(propName.toLowerCase());
        const mentionedInConv = conv.messages.some(m => m.content.toLowerCase().includes(propName.toLowerCase()));
        if (mentionedInReply || (needsImage && mentionedInConv)) {
          if (fs.existsSync(imgPath)) {
            try {
              const imgBuf = fs.readFileSync(imgPath);
              await sock.sendMessage(sender, {
                image: imgBuf,
                caption: `🏠 ${propName}`,
                mimetype: 'image/jpeg'
              });
              conv.sentImages.push(propName);
              console.log(`  📸 Sent ${propName} to ${phone}`);
            } catch(e) { console.log(`  📸 ${propName} err: ${e.message}`); }
          }
        }
      }
    }

    // --- Forward Booking/Seller Leads ---
    const userPhone = findPhone(text);
    const convText = conv.messages.map(m => m.content).join(' ').toLowerCase();
    const isBookingConv = convText.includes('visit') || convText.includes('book') || /\bsite\b/.test(convText);
    const isSellerConv = hasSellerInfo(convText) && userPhone;

    if (userPhone && (isBookingConv || isSellerConv)) {
      const leadType = isSellerConv ? 'Seller Lead' : 'Booking Lead';
      const leadMsg = `🔔 *New ${leadType}!*\n📱 ${userPhone}\n💬 "${text.slice(0,150)}"\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
      try { await sock.sendMessage(AGENT_JID, { text: leadMsg }); } catch(e) {}
      console.log(`📤 ${leadType} forwarded: ${userPhone}`);
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

  // --- Status Endpoint ---
  if (url.pathname === '/status') {
    const connected = !!(global.__sock && global.__sock.user);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ status: connected ? 'connected' : 'disconnected', phone: connected ? global.__sock.user.id?.split(':')[0] || 'unknown' : null }));
    return;
  }

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
      QR.toDataURL(qrData, { width: 500, margin: 4, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'L' }, (err, url) => {
        if (err) { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('QR error'); return; }
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:system-ui,sans-serif;padding:10px}.q{background:#fff;padding:20px;border-radius:12px;box-shadow:0 0 0 3px #000;max-width:340px;width:100%;text-align:center}img{width:100%;height:auto;max-width:280px;display:block;margin:0 auto}h3{font-size:16px;margin:16px 0 4px;color:#111}p{font-size:13px;color:#555;margin:2px 0}</style></head><body><div class="q"><img src="${url}" alt="QR"/><h3>Scan this QR with WhatsApp</h3><p>Open WhatsApp → Linked Devices → Link a Device</p></div></body></html>`);
      });
      return;
    }
  }
  res.writeHead(200, {'Content-Type': 'text/html'});
  if (url.pathname === '/qr') res.end('QR generating... Refresh.');
  else res.end('OK');
}).listen(PORT, () => console.log(`Server on ${PORT} — waiting for WhatsApp connection...`));

startBot();
