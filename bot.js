require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are "Sri Sai Properties" — a sales-oriented real estate assistant in Hyderabad. Your goal is to engage prospects, suggest properties, and book site visits.

AVAILABLE PROPERTIES:
1. Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready to move, Gachibowli
2. My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026, Kokapet
3. Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready to move, Tellapur
4. Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027, Nallagandla
5. KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready to move, Gachibowli
6. Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet
7. Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready to move, Tellapur

RULES:
- Keep replies short and conversational. 2-3 lines max.
- NEVER offer images or brochures. Say "I'll have our agent share those details."
- After suggesting properties, ask: "Would you like to book a visit this weekend?"
- If user agrees to visit, say: "Perfect! Let me note that down. What name should I put for the booking?"
- If user asks about budget: suggest matching properties.
- Sound like a friendly local Hyderabad agent. Use simple English.
- Always end with a question to keep the conversation flowing.
- Do NOT handle booking details yourself — just ask for name when they agree, and the system will handle the rest.`;

let conversationMemory = new Map();
const MEMORY_FILE = __dirname + '/memory.json';
try { const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); conversationMemory = new Map(Object.entries(saved)); } catch(e) {}
const AGENT_JID = process.env.AGENT_NUMBER || '';

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(Object.fromEntries(conversationMemory)));
}

async function getAIReply(userMessage) {
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

    // --- Booking Flow (natural conversation) ---
    if (conv.flow === 'booking') {
      if (conv.step === 0) {
        conv.data.name = text.trim();
        conv.step = 1;
        reply = `Thanks ${conv.data.name}! And your phone number? So the agent can confirm the slot with you.`;
      } else if (conv.step === 1) {
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length >= 10) {
          conv.data.phone = cleaned.slice(-10);
          conv.step = 2;
          reply = `Perfect! When would work best for you? Morning, afternoon, or evening — and which day?`;
        } else {
          reply = `Sorry, could you share a 10-digit number so the agent can reach you?`;
        }
      } else if (conv.step === 2) {
        conv.data.time = text.trim();
        conv.step = 3;
        reply = `Got it! And which property caught your interest? (Aparna Elita, Lodha Meridian, KNR Greenville, Prestige High Fields, or any other?)`;
      } else if (conv.step === 3) {
        conv.data.property = text.trim();
        conv.step = 4;
        reply = `Anything specific you'd like the agent to know before the visit? Any questions? (Or just say "no" to skip)`;
      } else if (conv.step === 4) {
        conv.data.notes = text.trim().toLowerCase() === 'no' || text.trim().toLowerCase() === 'none' ? '' : text.trim();

        const leadMsg = `🔔 *New Booking!*\n👤 ${conv.data.name}\n📱 ${conv.data.phone}\n📅 ${conv.data.time}\n🏠 ${conv.data.property}\n📝 ${conv.data.notes || '—'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        try {
          await sock.sendMessage(AGENT_JID, { text: leadMsg });
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
        await sock.sendMessage(sender, { text: reply });
        return;
      }

      conversationMemory.set(sender, conv);
      saveMemory();
      await sock.sendMessage(sender, { text: reply });
      return;
    }

    // --- Check if user wants to book ---
    const lower = text.toLowerCase().trim();
    const triggers = ['visit', 'book', 'yeah sure', 'yes', 'sure', 'ok', 'okay', "let's do", "let's go", 'want to see', 'show me', 'book slot', 'book visit', 'schedule visit', 'i\'m interested', 'sounds good', 'let\'s book'];

    if (triggers.some(t => lower === t || lower.includes(t))) {
      conv.flow = 'booking';
      conv.step = 0;
      conv.data = {};
      conversationMemory.set(sender, conv);
      saveMemory();
      reply = `Great choice! Let me get this sorted for you. What's your name?`;
      await sock.sendMessage(sender, { text: reply });
      return;
    }

    // --- Normal AI response ---
    try {
      reply = await getAIReply(text);
    } catch (e) {
      console.log(`Groq error: ${e.message}`);
    }

    if (!reply) {
      if (['hi', 'hello', 'hey', 'namaste'].includes(lower)) {
        reply = `Hey! Welcome to Sri Sai Properties. Looking for a home in Hyderabad? Tell me your budget and I'll find the best options for you.`;
      } else if (lower.includes('agent') || lower.includes('call') || lower.includes('talk')) {
        reply = `Sure, an agent will call you shortly. Please share your preferred time if any.`;
      } else if (lower.includes('thank')) {
        reply = `You're welcome! Let me know if you have any more questions. Happy to help!`;
      } else {
        reply = `I can help you find the perfect property in Gachibowli, Kokapet, or Tellapur. What's your budget range?`;
      }
    }

    await sock.sendMessage(sender, { text: reply });
    console.log(`✅ ${phone}: "${text.slice(0,35)}"`);
  });
}

startBot();
