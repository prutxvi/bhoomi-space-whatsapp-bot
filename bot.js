require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are "Sri Sai Properties" WhatsApp bot — a sales-oriented real estate assistant in Hyderabad.

AVAILABLE PROPERTIES:
1. Aparna Elita — 2BHK, 1280 sqft, ₹89L, Ready to move, Gachibowli
2. My Home Vihanga — 3BHK, 1650 sqft, ₹1.45Cr, Dec 2026 possession, Kokapet
3. Lodha Meridian — 2BHK, 1150 sqft, ₹78L, Ready to move, Tellapur
4. Rajapushpa Provincia — 3BHK, 1800 sqft, ₹1.6Cr, Mar 2027 possession, Nallagandla
5. KNR Greenville — 2BHK, 1350 sqft, ₹92L, Ready to move, Gachibowli
6. Godrej Ananda — 3BHK, 1725 sqft, ₹1.55Cr, Jun 2027, Kokapet
7. Prestige High Fields — 2BHK, 1190 sqft, ₹82L, Ready to move, Tellapur

CRITICAL RULES:
- Keep replies concise. 3-4 lines max. Never write paragraphs.
- NEVER offer to send images, brochures, PDFs, or photos — you CANNOT send files. Instead say: "I'll have our agent share the brochure on WhatsApp. Can I get your preferred contact number?"
- Push for lead capture: After 2-3 exchanges, ask: "Should I share your details with our agent for a personalized consultation?"
- Push for site visit: After suggesting properties, always ask: "Would you like to visit this weekend? I can book a slot."
- If budget under ₹1Cr, suggest Aparna Elita, Lodha Meridian, KNR Greenville, Prestige High Fields.
- If ₹1Cr-₹2Cr, suggest My Home Vihanga, Rajapushpa Provincia, Godrej Ananda.
- If user asks about areas: Gachibowli has 2BHK options, Kokapet has premium 3BHK, Tellapur has affordable options.
- If user wants a site visit: "✅ Booked! Our agent will confirm within 2 hours."
- If user wants to talk to an agent: "📞 An agent will call you shortly. Please share your preferred time."
- If user asks about investment: "Gachibowli corridor has seen 12-15% annual appreciation. Great time to invest."
- Never share exact addresses. Always route bookings through an agent.
- Sound like a helpful local agent. Be direct, knowledgeable, and sales-focused.
- Always end with a question to keep conversation going.`;

let conversationMemory = new Map();
const AGENT_JID = process.env.AGENT_NUMBER || '';

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

function hasBuyingIntent(text) {
  const lower = text.toLowerCase();
  const buyingSignals = [
    'visit', 'book', 'interested', 'call me', 'contact', 'send details',
    'confirm', 'meet', 'come see', 'let\'s meet', 'my number', 'my phone',
    'whatsapp me', 'reach me', 'call me at', 'contact me', 'schedule',
    'brochure', 'price list', 'deal', 'buy', 'purchase', 'book slot',
    'available today', 'want to see', 'show me', 'come to office'
  ];
  const phoneRegex = /[6-9]\d{9}/;
  return buyingSignals.some(s => lower.includes(s)) || phoneRegex.test(text);
}

async function forwardLead(sock, sender, text, reply) {
  if (!AGENT_JID) return;
  const phone = sender.split('@')[0];
  const msg = `🔔 *New Lead Alert!*\n\n📱 Lead: ${phone}\n💬 Said: "${text.slice(0, 100)}"\n🤖 Bot replied: "${reply.slice(0, 100)}"\n\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
  try {
    await sock.sendMessage(AGENT_JID, { text: msg });
    console.log(`📤 Lead forwarded for ${phone}`);
  } catch (e) {
    console.log('Forward failed:', e.message);
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
      console.log('\n✅ BOT IS LIVE! AI-powered WhatsApp bot connected.\n');
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
    const conv = conversationMemory.get(sender) || { count: 0, lastIntent: false };
    conv.count = (conv.count || 0) + 1;
    conversationMemory.set(sender, conv);

    await sock.sendPresenceUpdate('composing', sender);

    let reply = await getAIReply(text);

    if (!reply) {
      const lower = text.toLowerCase().trim();
      if (['hi', 'hello', 'hey', 'namaste'].includes(lower)) {
        reply = `🏡 *Welcome to Sri Sai Properties!*

We help you find the best apartments in Gachibowli, Kokapet, and Tellapur. 

What are you looking for? Tell me your *budget* and *BHK* preference and I'll find the best options for you.`;
      } else if (lower.includes('visit') || lower.includes('book')) {
        reply = `✅ *Site Visit Booked!*

Our agent will confirm your slot within 2 hours (9 AM — 7 PM).

Thank you for choosing *Sri Sai Properties*! 🏡`;
      } else if (lower.includes('agent') || lower.includes('call') || lower.includes('talk')) {
        reply = `📞 An agent will reach out to you shortly.

For urgent inquiries, you can expect a call within 30 minutes during business hours.`;
      } else if (lower.includes('thank')) {
        reply = `You're welcome! 😊 Feel free to ask if you have any more questions.

We're here to help you find the perfect home.`;
      } else {
        reply = `Thanks for your message! 

I can help you with:
• Available properties in Gachibowli, Kokapet, Tellapur
• Price ranges and BHK options
• Site visit bookings
• Investment guidance

Just tell me what you're looking for!`;
      }
    }

    await sock.sendMessage(sender, { text: reply });
    console.log(`✅ Replied to: ${phone} — "${text.slice(0,40)}"`);

    const intent = hasBuyingIntent(text);
    if (intent || conv.count >= 4) {
      await forwardLead(sock, sender, text, reply);
      conversationMemory.set(sender, { count: conv.count, lastIntent: true, forwarded: true });
    }
  });
}

startBot();
