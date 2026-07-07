const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome (Linux)', '', ''],
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n========== SCAN THIS QR CODE WITH YOUR WHATSAPP ==========\n');
      qrcode.generate(qr, { small: true });
      console.log('\n==========================================================');
      console.log('Open WhatsApp -> Linked Devices -> Link a Device -> Scan this QR\n');
    }
    if (connection === 'open') {
      console.log('✅ BOT IS LIVE! Your WhatsApp bot is ready.');
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const sender = msg.key.remoteJid;

    if (!text) return;

    const lower = text.toLowerCase().trim();

    let reply = '';

    if (lower === 'hi' || lower === 'hello' || lower === 'hey') {
      reply = `🏡 *Welcome to Sri Sai Properties!*

We help you find the best apartments in Gachibowli, Kokapet, and Tellapur.

Reply with:
1️⃣ *Budget* — under ₹1Cr / ₹1-2Cr / 2Cr+
2️⃣ *BHK* — 2BHK / 3BHK
3️⃣ *Book a site visit*
4️⃣ *Talk to an agent*`;
    } else if (lower === '1' || lower.includes('budget') || lower.includes('1cr') || lower.includes('2cr')) {
      reply = `*Available Properties in Gachibowli:*

🏠 *Aparna Elita* — 2BHK, 1280 sqft, ₹89L (Ready to move)
🏠 *My Home Vihanga* — 3BHK, 1650 sqft, ₹1.45Cr (Dec 2026)
🏠 *Lodha Meridian* — 2BHK, 1150 sqft, ₹78L (Ready)
🏠 *Rajapushpa Provincia* — 3BHK, 1800 sqft, ₹1.6Cr (Mar 2027)
🏠 *KNR Greenville* — 2BHK, 1350 sqft, ₹92L (Ready)

Reply *Visit [name]* to book a site visit.`;
    } else if (lower === '2' || lower.includes('bhk')) {
      reply = `*BHK Options Available:*
• 2BHK — ₹78L to ₹95L
• 3BHK — ₹1.45Cr to ₹1.8Cr

Which one interests you?`;
    } else if (lower === '3' || lower.includes('visit') || lower.includes('book')) {
      reply = `✅ *Site Visit Booked!*

Our agent will confirm your slot within 2 hours.
We operate 9 AM — 7 PM, all 7 days.

Thank you for choosing *Sri Sai Properties*! 🏡`;
    } else if (lower === '4' || lower.includes('agent') || lower.includes('talk') || lower.includes('call')) {
      reply = `📞 *Talk to an Agent*

Our team will reach out to you shortly.

For urgent inquiries, call: *+91-XXXXXXXXXX*

We're here to help you find your dream home!`;
    } else {
      reply = `Thanks for your message! Our AI assistant is processing your query.

Reply with:
1️⃣ *See available properties*
2️⃣ *Check BHK options*
3️⃣ *Book a site visit*
4️⃣ *Talk to an agent*`;
    }

    await sock.sendMessage(sender, { text: reply });
  });
}

startBot();
