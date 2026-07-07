require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');

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
      console.log('  QR also saved to: qr.txt (for this terminal)');
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
    const conv = conversationMemory.get(sender) || { count: 0, flow: null, step: 0, data: {} };
    conv.count = (conv.count || 0) + 1;
    conversationMemory.set(sender, conv);

    let reply = '';

    // --- Booking Flow ---
    if (conv.flow === 'booking') {
      if (conv.step === 0) {
        conv.data.name = text.trim();
        conv.step = 1;
        reply = `Thanks, *${conv.data.name}*! 📱\n\nCould you share your *phone number* so our agent can reach you?`;
      } else if (conv.step === 1) {
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length >= 10) {
          conv.data.phone = cleaned.slice(-10);
          conv.step = 2;
          reply = `Great! What *date and time* would you prefer for the site visit? (e.g., "Tomorrow 4 PM" or "Saturday 11 AM")`;
        } else {
          reply = `Please share a valid *10-digit phone number* so our agent can reach you.`;
        }
      } else if (conv.step === 2) {
        conv.data.time = text.trim();
        conv.step = 3;
        reply = `Which *property* are you interested in visiting? (e.g., Aparna Elita, Lodha Meridian, KNR Greenville, Prestige High Fields)`;
      } else if (conv.step === 3) {
        conv.data.property = text.trim();
        conv.step = 4;
        reply = `Almost done! Any *specific requirements* or *questions* for our agent? (Reply "none" to skip)`;
      } else if (conv.step === 4) {
        conv.data.notes = text.trim() === 'none' ? '' : text.trim();
        
        // Booking complete — forward to admin
        const leadMsg = `🔔 *New Site Visit Booking!*\n\n👤 Name: ${conv.data.name}\n📱 Phone: ${conv.data.phone}\n📅 Preferred Time: ${conv.data.time}\n🏠 Property: ${conv.data.property}\n📝 Notes: ${conv.data.notes || 'None'}\n\n🕐 Booked at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        
        try {
          await sock.sendMessage(AGENT_JID, { text: leadMsg });
          console.log(`📤 Booking forwarded for ${phone}`);
        } catch (e) {
          console.log('Forward failed:', e.message);
        }

        reply = `✅ *Site Visit Booked Successfully!* 🎉

Here's your booking summary:
👤 *Name:* ${conv.data.name}
📱 *Phone:* ${conv.data.phone}
📅 *Preferred Time:* ${conv.data.time}
🏠 *Property:* ${conv.data.property}

Our agent will contact you shortly to confirm the slot. Thank you for choosing *Sri Sai Properties*! 🏡`;

        // Reset booking flow
        conv.flow = null;
        conv.step = 0;
        conv.data = {};
        conversationMemory.set(sender, conv);
        await sock.sendMessage(sender, { text: reply });
        return;
      }

      conversationMemory.set(sender, conv);
      await sock.sendMessage(sender, { text: reply });
      return;
    }

    // --- Start Booking Flow ---
    const lower = text.toLowerCase().trim();
    const bookingTriggers = ['visit', 'book', 'yeah sure', 'yes', 'sure', 'ok', 'okay', "let's do", "let's go", 'book slot', 'book visit', 'schedule visit', 'want to see', 'show me'];

    if (bookingTriggers.some(t => lower === t || lower.includes(t))) {
      conv.flow = 'booking';
      conv.step = 0;
      conv.data = {};
      conversationMemory.set(sender, conv);
      reply = `🏡 *Great! Let's book your site visit.*

First, what's your *name*?`;
      await sock.sendMessage(sender, { text: reply });
      return;
    }

    // --- Normal AI response ---
    try {
      reply = await getAIReply(text);
    } catch (e) {
      console.log(`Groq error for ${phone}:`, e.message);
    }

    if (!reply) {
      if (['hi', 'hello', 'hey', 'namaste'].includes(lower)) {
        reply = `🏡 *Welcome to Sri Sai Properties!*

We help you find the best apartments in Gachibowli, Kokapet, and Tellapur. 

What are you looking for? Tell me your *budget* and *BHK* preference and I'll find the best options for you.`;
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
  });
}

startBot();
