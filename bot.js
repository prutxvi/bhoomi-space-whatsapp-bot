require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');
const http = require('http');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are "Sri Sai Properties" WhatsApp assistant — a professional real estate agent in Hyderabad.

YOUR JOB: Chat naturally, understand what the person needs, then route them correctly. You are NOT just a property listing bot. You are a SMART FILTER.

OPENING RULES:
- First message: Be neutral. "Hello! How can I help you today?" — NEVER start with "Looking for a property?"
- Let THEM tell you what they want. Don't assume.
- Many people message to: sell their property, check prices, ask about areas, or just browse.

INTENT CLASSIFICATION (understand this BEFORE suggesting anything):
1. BUYER — mentions budget, BHK, wants to buy/visit. → Suggest properties, offer site visit.
2. SELLER — "I want to sell my flat/house/plot." → Ask for details (area, BHK, price expectation, contact). Tell them: "I'll have our agent contact you about selling."
3. PRICE CHECK — "What's the price in Gachibowli?" → Give general market info. No need to forward to agent.
4. RENTER — "Looking for rental." → Tell them: "We mainly handle sales. I can ask our agent to suggest rental options. Want me to?"
5. BROWSER — "Just checking" / no clear intent → Answer briefly. Don't push.
6. JUNK/SCAM — nonsensical messages, spam → Just reply "How can I help you?" once. If still junk, stop engaging.

FORWARDING RULES:
- ONLY forward BUYER leads to the agent (when they ask for visit or share contact)
- SELLER leads: collect info first, then forward
- PRICE CHECK / BROWSER / JUNK: Do NOT forward. Just answer.

AVAILABLE PROPERTIES (use only when someone is a BUYER):
🏠 Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready, Gachibowli
🏠 Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready, Tellapur
🏠 Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready, Tellapur
🏠 KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready, Gachibowli
🏠 My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026, Kokapet
🏠 Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027, Nallagandla
🏠 Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet

CRITICAL RULES:
- Be conversational. 2-3 lines max.
- NEVER offer images/brochures — say "I'll have our agent share the details."
- Sound like a knowledgeable Hyderabad agent.
- Use Telugu/English mix naturally.
- If someone is clearly a BUYER, suggest matching properties and ask about site visit.
- If someone is a SELLER, collect their details and say agent will contact.
- Filter out time-wasters. Only engage seriously with real prospects.`;

let conversationMemory = new Map();
const MEMORY_FILE = __dirname + '/memory.json';
try { const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); conversationMemory = new Map(Object.entries(saved)); } catch(e) {}
const AGENT_JID = process.env.AGENT_NUMBER || '';

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(conversationMemory)));
}

async function sendMsg(sock, jid, msg) {
  try { await sock.sendMessage(jid, msg); } catch (e) { console.log('Send error:', e.message); }
}

async function getAIReply(userMessage, lang = 'english') {
  const langInstruction = lang === 'telugu' ? 'IMPORTANT: Always reply in TELUGU (తెలుగు). Use Telugu script. Be natural like a local Hyderabad agent.'
    : lang === 'hindi' ? 'IMPORTANT: Always reply in HINDI (हिंदी). Use Devanagari script. Be natural.'
    : 'IMPORTANT: Reply in ENGLISH. Be conversational.';
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 300
    });
    return completion.choices[0]?.message?.content || '';
  } catch (e) {
    console.log('Groq API error:', e.message);
    return null;
  }
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
    const conv = conversationMemory.get(sender) || { count: 0, flow: null, step: 0, data: {} };
    conv.count = (conv.count || 0) + 1;

    let reply = '';

    const lower = text.toLowerCase().trim();

    // --- Language Selection (for new users) ---
    if (conv.flow === 'booking') {
      if (conv.step === 0) {
        conv.data.name = text.trim();
        conv.step = 1;
        reply = `Thanks ${conv.data.name}! And your phone number? I'll share it with our agent so they can confirm the visit.`;
      } else if (conv.step === 1) {
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length >= 10) {
          conv.data.phone = cleaned.slice(-10);
          conv.step = 2;
          reply = `Perfect! When would work best for you? Morning, afternoon, or evening — and which day?`;
        } else {
          reply = `Sorry, could you share a 10-digit number so our agent can reach you?`;
        }
      } else if (conv.step === 2) {
        conv.data.time = text.trim();
        conv.step = 3;
        reply = `Got it! And which property caught your interest? We have Aparna Elita, Lodha Meridian, KNR Greenville, and a few others.`;
      } else if (conv.step === 3) {
        conv.data.property = text.trim();
        conv.step = 4;
        reply = `Anything specific you'd like the agent to know beforehand? Any questions you have? (Or just say "no")`;
      } else if (conv.step === 4) {
        conv.data.notes = text.trim().toLowerCase() === 'no' || text.trim().toLowerCase() === 'none' ? '' : text.trim();

        const leadMsg = `🔔 *New Booking!*\n👤 ${conv.data.name}\n📱 ${conv.data.phone}\n📅 ${conv.data.time}\n🏠 ${conv.data.property}\n📝 ${conv.data.notes || '—'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        try {
          try { await sock.sendMessage(AGENT_JID, { text: leadMsg }); } catch(e) {}
          console.log(`📤 Booking: ${conv.data.name} — ${phone}`);
        } catch (e) {
          console.log('Forward failed:', e.message);
        }

        reply = `You're all set ${conv.data.name}! 🎉

Here's what I've noted:
👤 ${conv.data.name}
📱 ${conv.data.phone}
📅 ${conv.data.time}
🏠 ${conv.data.property}

Our agent will confirm the slot shortly. See you at the site!`;

        conv.flow = null;
        conv.step = 0;
        conv.data = {};
        conversationMemory.set(sender, conv);
        saveMemory();
        await sendMsg(sock, sender, { text: reply });
        return;
      }

      conversationMemory.set(sender, conv);
      saveMemory();
      await sendMsg(sock, sender, { text: reply });
      return;
    }

    // --- Language Selection (for new users) ---
if (!conv.lang) {
  const langMap = { '1': 'telugu', '2': 'english', '3': 'hindi', 'telugu': 'telugu', 'english': 'english', 'hindi': 'hindi', 'te': 'telugu', 'en': 'english', 'hi': 'hindi' };
  const chosen = langMap[lower] || '';
  if (chosen) {
    conv.lang = chosen;
    conversationMemory.set(sender, conv);
    saveMemory();
    reply = chosen === 'telugu' ? '👋 *Sri Sai Properties* ki swagatam! Meeru em kondalanukun-tunnaru? Meeru budget entha anukuntunnaru?' 
         : chosen === 'hindi' ? '👋 *Sri Sai Properties* mein aapka swagat hai! Aap kya dhundh rahe hain? Budget kitna hai?'
         : '👋 Welcome to *Sri Sai Properties*! Looking for a home in Hyderabad? What\'s your budget?';
    await sendMsg(sock, sender, { text: reply });
    return;
  }
  reply = `*Welcome to Sri Sai Properties!* 🏡 Please choose your language / Basha select cheyandi / Bhasha chuniye:\n\n1️⃣ Telugu\n2️⃣ English\n3️⃣ Hindi`;
  await sendMsg(sock, sender, { text: reply });
  return;
}

// --- Check if user wants to book ---
    const triggers = ['visit', 'book', 'yeah sure', 'yes', 'sure', 'ok', 'okay', "let's do", "let's go", 'want to see', 'show me', 'book slot', 'book visit', 'schedule visit', 'i\'m interested', 'sounds good', 'let\'s book'];

    if (triggers.some(t => lower === t || lower.includes(t))) {
      conv.flow = 'booking';
      conv.step = 0;
      conv.data = {};
      conversationMemory.set(sender, conv);
      saveMemory();
      reply = `Great choice! Let me get this sorted for you. What's your name?`;
      await sendMsg(sock, sender, { text: reply });
      return;
    }

    // --- Normal AI response ---
    try {
      reply = await getAIReply(text, conv.lang || 'english');
    } catch (e) {
      console.log(`Groq error: ${e.message}`);
    }

    if (!reply) {
      const fallbackHi = conv.lang === 'telugu' ? 'Namaste! Sri Sai Properties. Meeru em kavali?'
        : conv.lang === 'hindi' ? 'Namaste! Sri Sai Properties. Aapko kya chahiye?'
        : 'Hello! Sri Sai Properties. How can I help you today?';
      const fallbackAgent = conv.lang === 'telugu' ? 'Sare, maa agent mee call chestaru. Mee preferred time cheppandi.'
        : conv.lang === 'hindi' ? 'Theek hai, humara agent aapko call karega. Apna preferred time batao.'
        : 'Sure, our agent will call you. Share your preferred time?';
      const fallbackThanks = conv.lang === 'telugu' ? 'Dhanyavadalu! Inka doubts unte adagandi.'
        : conv.lang === 'hindi' ? 'Shukriya! Koi aur sawaal hai to puchiye.'
        : 'Thank you! Let me know if you have more questions.';

      if (['hi', 'hello', 'hey', 'namaste'].includes(lower)) {
        reply = fallbackHi;
      } else if (lower.includes('agent') || lower.includes('call') || lower.includes('talk')) {
        reply = fallbackAgent;
      } else if (lower.includes('thank')) {
        reply = fallbackThanks;
      } else {
        reply = fallbackHi;
      }
    }

    await sendMsg(sock, sender, { text: reply });
    console.log(`✅ ${phone}: "${text.slice(0,35)}"`);
  });
}

// HTTP server for Railway — serves QR as PNG and health check
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const qrFile = __dirname + '/qr.txt';
  const qrPng = __dirname + '/qr.png';
  
  if (req.url === '/qr' && fs.existsSync(qrFile)) {
    const qrData = fs.readFileSync(qrFile, 'utf8').trim();
    if (qrData) {
      if (fs.existsSync(qrPng) && Date.now() - fs.statSync(qrPng).mtimeMs < 60000) {
        const img = fs.readFileSync(qrPng);
        res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': img.length});
        res.end(img);
      } else {
        QR.toFile(qrPng, qrData, { width: 500, margin: 2, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'L', type: 'png' }, (err) => {
          if (err) { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('QR error'); return; }
          const img = fs.readFileSync(qrPng);
          res.writeHead(200, {'Content-Type': 'image/png', 'Content-Length': img.length});
          res.end(img);
        });
      }
      return;
    }
  }
  
  res.writeHead(200, {'Content-Type': 'text/html'});
  if (req.url === '/qr') res.end('QR not ready yet. Refresh in 10 seconds.');
  else res.end('OK');
}).listen(PORT, () => console.log(`Server on ${PORT}`));

startBot();
