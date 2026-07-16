require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');
const express = require('express');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function buildPropList(ps) {
  return ps.map(p => `🏠 ${p.name} — ${p.bhk}, ${p.size}, ${p.price}, ${p.status}, ${p.area}`).join('\n');
}
function buildBudgetRanges(ps) {
  const under = ps.filter(p => p.budget === 'under1cr').map(p => p.name).join(', ');
  const mid = ps.filter(p => p.budget === '1to2cr').map(p => p.name).join(', ');
  const over = ps.filter(p => p.budget === 'over1cr').map(p => p.name).join(', ');
  let s = '';
  if (under) s += `- Under ₹1Cr: ${under}\n`;
  if (mid) s += `- ₹1Cr-₹2Cr: ${mid}\n`;
  if (over) s += `- Over ₹2Cr: ${over}\n`;
  return s;
}

function loadProperties() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/properties.json', 'utf8'));
  } catch(e) { return []; }
}

function buildImageMap(props) {
  const m = {};
  props.forEach(p => {
    const fname = p.name.toLowerCase().replace(/\s+/g, '-') + '.jpg';
    m[p.name] = __dirname + '/images/' + fname;
  });
  return m;
}

function getSystemPrompt() {
  const props = loadProperties();
  const propList = buildPropList(props);
  const budgetRanges = buildBudgetRanges(props);
  return `You are "Sri Sai Properties" — a real estate WhatsApp assistant in Hyderabad.

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
${propList}

BUDGET RANGES:
${budgetRanges}
AREA INFO:
- Gachibowli: IT hub, 2BHK from ₹78L, good for families
- Kokapet: Premium area, 3BHK from ₹1.45Cr
- Tellapur: Affordable, 2BHK from ₹78L, upcoming area
- Nallagandla: New development, connected to ORR`;
}

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
    { role: 'system', content: getSystemPrompt() + '\n' + langInstruction },
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
      const propImages = buildImageMap(loadProperties());
      for (const [propName, imgPath] of Object.entries(propImages)) {
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

// Express server for Railway
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const { sendProjectAssets, validatePhone } = require('./routes/sendProject');

// --- New API: Send Project Assets via WhatsApp ---
app.post('/api/send-project', async (req, res) => {
  try {
    const { phone, project } = req.body;
    if (!phone || !project) {
      return res.status(400).json({ success: false, message: 'Missing required fields: phone, project' });
    }
    const validPhone = validatePhone(phone);
    if (!validPhone) {
      return res.status(400).json({ success: false, message: 'Invalid phone number' });
    }
    const sock = global.__sock;
    if (!sock) {
      return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
    }
    const result = await sendProjectAssets(sock, validPhone, project);
    if (result.success) {
      return res.json(result);
    }
    return res.status(404).json(result);
  } catch (e) {
    console.error('Send project error:', e);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// --- Properties API ---
app.get('/api/properties', (req, res) => {
  const key = req.query.key || '';
  if (key !== (process.env.ADMIN_KEY || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(loadProperties());
});

app.post('/api/properties', (req, res) => {
  const key = req.query.key || '';
  if (key !== (process.env.ADMIN_KEY || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    fs.writeFileSync(__dirname + '/properties.json', JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// --- Admin Page ---
app.get('/admin', (req, res) => {
  const key = req.query.key || '';
  const validKey = process.env.ADMIN_KEY || 'admin123';
  const authed = key === validKey;
  res.type('html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Property Admin</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f5f5f5;padding:20px}h1{color:#075e54;margin-bottom:20px}.card{background:#fff;padding:20px;border-radius:12px;box-shadow:0 1px 8px rgba(0,0,0,.08);margin-bottom:20px;overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{background:#075e54;color:#fff;padding:10px 8px;text-align:left}td{padding:8px;border-bottom:1px solid #eee}input,select{width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px}.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}.btn-primary{background:#075e54;color:#fff}.btn-danger{background:#dc3545;color:#fff}.btn-sm{padding:4px 10px;font-size:12px}.actions{display:flex;gap:8px;align-items:center}.login{max-width:400px;margin:100px auto;text-align:center}.login input{width:100%;padding:10px;margin:10px 0;border:1px solid #ddd;border-radius:8px;font-size:16px}.login button{width:100%;padding:10px;background:#075e54;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}.badge-green{background:#e8f5e9;color:#2e7d32}.badge-yellow{background:#fff8e1;color:#f57f17}.add-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:16px}.add-form input,.add-form select{width:100%}.save-bar{position:sticky;bottom:0;background:#075e54;color:#fff;padding:12px 20px;border-radius:12px;display:flex;justify-content:space-between;align-items:center;margin-top:20px;display:none}.save-bar .btn{background:#fff;color:#075e54}</style></head><body>
${!authed ? `
<div class="login"><h1>🔐 Admin Login</h1><form method="get" action="/admin"><input type="password" name="key" placeholder="Enter admin key"/><button type="submit">Login</button></form></div>` : `
<h1>🏠 Property Management</h1>
<div class="card"><h3 style="margin-bottom:12px">Add Property</h3>
<div class="add-form">
<input id="newName" placeholder="Name"/>
<select id="newBhk"><option value="1BHK">1BHK</option><option value="2BHK" selected>2BHK</option><option value="3BHK">3BHK</option><option value="4BHK">4BHK</option></select>
<input id="newSize" placeholder="Size (e.g. 1280 sqft)"/>
<input id="newPrice" placeholder="Price (e.g. ₹89L)"/>
<input id="newStatus" placeholder="Status (e.g. Ready)"/>
<input id="newArea" placeholder="Area (e.g. Gachibowli)"/>
<select id="newBudget"><option value="under1cr">Under ₹1Cr</option><option value="1to2cr">₹1Cr-₹2Cr</option><option value="over1cr">Over ₹2Cr</option></select>
<button class="btn btn-primary" onclick="addProp()">+ Add</button>
</div></div>
<div class="card"><table><thead><tr><th>Name</th><th>BHK</th><th>Size</th><th>Price</th><th>Status</th><th>Area</th><th>Budget</th><th></th></tr></thead><tbody id="propTable"></tbody></table></div>
<div class="save-bar" id="saveBar"><span id="saveStatus">Unsaved changes</span><button class="btn" onclick="saveAll()">💾 Save Changes</button></div>
<script>
let props = [];
async function load(){const r=await fetch('/api/properties?key=${key}');props=await r.json();render();}
function render(){const t=document.getElementById('propTable');t.innerHTML=props.map((p,i)=>'<tr>'+
'<td><input value="'+p.name.replace(/"/g,'&quot;')+'" onchange="edit('+i+',\'name\',this.value)"/></td>'+
'<td><select onchange="edit('+i+',\'bhk\',this.value)"><option value="1BHK"'+(p.bhk==='1BHK'?' selected':'')+'>1BHK</option><option value="2BHK"'+(p.bhk==='2BHK'?' selected':'')+'>2BHK</option><option value="3BHK"'+(p.bhk==='3BHK'?' selected':'')+'>3BHK</option><option value="4BHK"'+(p.bhk==='4BHK'?' selected':'')+'>4BHK</option></select></td>'+
'<td><input value="'+p.size+'" onchange="edit('+i+',\'size\',this.value)"/></td>'+
'<td><input value="'+p.price.replace(/"/g,'&quot;')+'" onchange="edit('+i+',\'price\',this.value)"/></td>'+
'<td><input value="'+p.status+'" onchange="edit('+i+',\'status\',this.value)"/></td>'+
'<td><input value="'+p.area+'" onchange="edit('+i+',\'area\',this.value)"/></td>'+
'<td><select onchange="edit('+i+',\'budget\',this.value)"><option value="under1cr"'+(p.budget==='under1cr'?' selected':'')+'>Under ₹1Cr</option><option value="1to2cr"'+(p.budget==='1to2cr'?' selected':'')+'>₹1Cr-₹2Cr</option><option value="over1cr"'+(p.budget==='over1cr'?' selected':'')+'>Over ₹2Cr</option></select></td>'+
'<td><button class="btn btn-danger btn-sm" onclick="delProp('+i+')">✕</button></td></tr>').join('');
document.getElementById('saveBar').style.display=props.some(p=>p._dirty)?'flex':'none';}
function edit(i,k,v){props[i][k]=v;props[i]._dirty=true;render();}
function delProp(i){props.splice(i,1);render();}
function addProp(){const n=i=>document.getElementById(i).value;props.push({name:n('newName'),bhk:n('newBhk'),size:n('newSize'),price:n('newPrice'),status:n('newStatus'),area:n('newArea'),budget:n('newBudget'),_dirty:true});['newName','newSize','newPrice','newStatus','newArea'].forEach(i=>document.getElementById(i).value='');render();}
async function saveAll(){const b=document.getElementById('saveStatus');b.textContent='Saving...';const r=await fetch('/api/properties?key=${key}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(props.map(p=>({name:p.name,bhk:p.bhk,size:p.size,price:p.price,status:p.status,area:p.area,budget:p.budget})))});const d=await r.json();if(d.ok){props.forEach(p=>delete p._dirty);b.textContent='✅ Saved!';setTimeout(()=>b.textContent='',2000);render();}else{b.textContent='❌ Save failed';}}
load();
</script>`}
</body></html>`);
});

// --- Status Endpoint ---
app.get('/status', (req, res) => {
  const connected = !!(global.__sock && global.__sock.user);
  res.json({ status: connected ? 'connected' : 'disconnected', phone: connected ? global.__sock.user.id?.split(':')[0] || 'unknown' : null });
});

// --- Pairing Code Endpoint ---
app.get('/pair', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) {
    res.type('html');
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:16px;font-family:sans-serif}input,button{font-size:18px;padding:10px;border:2px solid #ddd;border-radius:8px}button{background:#25D366;color:#fff;border:none;cursor:pointer}form{display:flex;gap:10px;max-width:400px;flex-wrap:wrap}</style></head><body><h3>WhatsApp Pairing</h3><form method="get" action="/pair"><input type="tel" name="phone" placeholder="91XXXXXXXXXX" required/><button type="submit">Get Code</button></form><p style="margin-top:12px;color:#666;font-size:13px">Enter your WhatsApp number with country code (without +)</p></body></html>`);
  }
  try {
    const sock = global.__sock;
    if (!sock) { return res.send('Bot not ready. Wait 10 seconds and refresh.'); }
    const code = await sock.requestPairingCode(phone);
    const display = typeof code === 'string' ? code.match(/.{1,4}/g)?.join('-') || code : code;
    res.type('html');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f0faf0;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:sans-serif;text-align:center;flex-direction:column;padding:20px}.card{background:#fff;padding:30px;border-radius:16px;box-shadow:0 2px 24px rgba(0,0,0,.1);max-width:400px}.code{font-size:42px;font-weight:700;letter-spacing:6px;color:#075e54;background:#e8f5e9;padding:20px;border-radius:12px;margin:15px 0;font-family:monospace}.step{color:#333;font-size:15px;margin:6px 0}.num{color:#999;font-size:13px;margin-top:15px}</style></head><body><div class="card"><h2 style="color:#075e54">Pairing Code</h2><div class="code">${display}</div><p class="step">1️⃣ Open WhatsApp on your phone</p><p class="step">2️⃣ Settings → <b>Linked Devices</b></p><p class="step">3️⃣ Tap <b>Link a Device</b></p><p class="step">4️⃣ Enter this code</p><p class="num">Phone: ${phone} · Code expires in 2 minutes</p></div></body></html>`);
  } catch (e) {
    res.type('html');
    res.send(`Error: ${e.message}. Try again in 10 seconds.`);
  }
});

// --- QR Endpoint (raw JSON or image) ---
app.get('/qr', (req, res) => {
  const qrFile = __dirname + '/qr.txt';
  const format = req.query.format || 'html';
  if (!fs.existsSync(qrFile)) {
    if (format === 'json') return res.json({ qr: null, message: 'QR generating...' });
    return res.type('html').send('QR generating... Refresh.');
  }
  const qrData = fs.readFileSync(qrFile, 'utf8').trim();
  if (!qrData) {
    if (format === 'json') return res.json({ qr: null, message: 'QR generating...' });
    return res.type('html').send('QR generating... Refresh.');
  }
  if (format === 'json') return res.json({ qr: qrData });

  QR.toDataURL(qrData, { width: 500, margin: 4, color: { dark: '#000000', light: '#ffffff' }, errorCorrectionLevel: 'L' }, (err, url) => {
    if (err) { return res.type('html').send('QR error'); }
    res.type('html');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="refresh" content="10"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:system-ui,sans-serif;padding:10px}.q{background:#fff;padding:20px;border-radius:12px;box-shadow:0 0 0 3px #000;max-width:340px;width:100%;text-align:center}img{width:100%;height:auto;max-width:280px;display:block;margin:0 auto}h3{font-size:16px;margin:16px 0 4px;color:#111}p{font-size:13px;color:#555;margin:2px 0}</style></head><body><div class="q"><img src="${url}" alt="QR"/><h3>Scan this QR with WhatsApp</h3><p>Open WhatsApp → Linked Devices → Link a Device</p><p style="margin-top:12px;font-size:11px;color:#999">Auto-refreshes every 10s</p></div></body></html>`);
  });
});

// --- Landing Page ---
app.get('/', (req, res) => {
  const connected = !!(global.__sock && global.__sock.user);
  const phone = connected ? global.__sock.user.id?.split(':')[0] || 'unknown' : null;
  const qrFile = __dirname + '/qr.txt';
  const hasQR = fs.existsSync(qrFile) && fs.readFileSync(qrFile, 'utf8').trim().length > 0;

  res.type('html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bhoomi Space - WhatsApp Bot</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f0faf0;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.card{background:#fff;border-radius:16px;box-shadow:0 2px 24px rgba(0,0,0,.1);max-width:420px;width:100%;padding:32px;text-align:center}h1{color:#075e54;font-size:24px;margin-bottom:4px}.sub{color:#666;font-size:14px;margin-bottom:24px}.status{padding:12px 16px;border-radius:10px;font-size:14px;font-weight:600;margin-bottom:20px}.connected{background:#e8f5e9;color:#2e7d32}.disconnected{background:#fff3e0;color:#e65100}.qr-box{background:#f9f9f9;border-radius:12px;padding:20px;margin-bottom:16px}.qr-box img{width:220px;height:220px;display:block;margin:0 auto 12px}.qr-box p{font-size:13px;color:#555;margin-bottom:4px}.pair-form{display:flex;gap:8px;margin-top:16px}.pair-form input{flex:1;padding:10px 14px;border:2px solid #ddd;border-radius:8px;font-size:14px;outline:none}.pair-form input:focus{border-color:#25D366}.pair-form button{padding:10px 20px;background:#25D366;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}.pair-form button:hover{background:#1da851}.links{margin-top:20px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.links a{color:#075e54;text-decoration:none;font-size:13px;padding:6px 14px;border:1px solid #075e54;border-radius:8px}.links a:hover{background:#075e54;color:#fff}.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;margin-top:16px}.badge-green{background:#e8f5e9;color:#2e7d32}.badge-red{background:#ffebee;color:#c62828}.api-endpoint{background:#f5f5f5;border-radius:8px;padding:8px 12px;font-family:monospace;font-size:12px;color:#333;margin-top:12px;text-align:left}.api-endpoint code{color:#075e54}</style></head><body>
<div class="card">
  <h1>🏡 Bhoomi Space</h1>
  <p class="sub">WhatsApp Bot</p>

  <div class="status ${connected ? 'connected' : 'disconnected'}">
    ${connected ? '✅ Connected — ' + phone : '❌ Not connected'}
  </div>

  ${!connected && hasQR ? `
  <div class="qr-box">
    <img src="/qr" alt="QR Code"/>
    <p>1. Open WhatsApp on your phone</p>
    <p>2. Settings → <b>Linked Devices</b></p>
    <p>3. Tap <b>Link a Device</b></p>
    <p style="font-size:11px;color:#999;margin-top:8px">Page refreshes automatically every 10s</p>
  </div>
  ` : !connected ? `
  <div class="qr-box">
    <p style="color:#999;padding:20px 0">⏳ Waiting for QR code...</p>
    <p style="font-size:12px;color:#999">Page refreshes automatically</p>
  </div>
  ` : ''}

  ${!connected ? `
  <div style="border-top:1px solid #eee;padding-top:16px;margin-top:4px">
    <p style="font-size:13px;color:#666;margin-bottom:8px">Or use pairing code:</p>
    <form class="pair-form" action="/pair" method="get">
      <input type="tel" name="phone" placeholder="91XXXXXXXXXX" required/>
      <button type="submit">Get Code</button>
    </form>
  </div>
  ` : ''}

  <div class="links">
    <a href="/status">📊 Status</a>
    <a href="/admin?key=${process.env.ADMIN_KEY || ''}">⚙️ Admin</a>
  </div>

  <div class="api-endpoint">
    <div style="font-weight:600;margin-bottom:4px">📡 API Endpoint</div>
    <code>POST /api/send-project</code>
  </div>

  <div class="badge ${connected ? 'badge-green' : 'badge-red'}">
    ${connected ? 'Bot is live' : 'Awaiting login'}
  </div>
</div>
<meta http-equiv="refresh" content="10">
</body></html>`);
});

app.listen(PORT, () => console.log(`Server on ${PORT} — waiting for WhatsApp connection...`));

startBot();
