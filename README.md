# WhatsApp AI Real Estate Bot

An AI-powered WhatsApp bot for real estate lead capture and qualification. Built with Node.js, Baileys, and Groq LLM.

## Features

- **24/7 Lead Capture** — Responds instantly to WhatsApp inquiries
- **AI-Powered Conversations** — Uses Groq LLM (llama-3.3-70b) to understand natural language
- **Property Recommendations** — Suggests matching properties based on budget and preferences
- **Site Visit Booking** — Captures intent and routes to human agents
- **Lead Qualification** — Asks qualifying questions to capture contact details
- **Multi-Property Support** — 7+ properties across Gachibowli, Kokapet, Tellapur

## Tech Stack

| Component | Technology |
|-----------|-----------|
| WhatsApp | Baileys (WhatsApp Web protocol) |
| AI/LLM | Groq (llama-3.3-70b-versatile) |
| Runtime | Node.js v26+ |
| Auth Storage | Local multi-file auth state |

## Quick Start

```bash
# Clone the repo
git clone https://github.com/prutxvi/whatsapp-bot.git
cd whatsapp-bot

# Install dependencies
npm install

# Set your Groq API key
echo "GROQ_API_KEY=your_key_here" > .env

# Run the bot
node bot.js
```

Scan the QR code with your WhatsApp number to connect.

## Pricing Model

| Item | Amount |
|------|--------|
| Setup fee (one-time) | ₹25,000 |
| Monthly maintenance | ₹5,000/month |
| Client cost structure | ₹1,500-3,000/month BSP + negligible AI cost |

## Configuration

Edit `.env` file:
```
GROQ_API_KEY=gsk_your_key_here
```

Modify `SYSTEM_PROMPT` in `bot.js` to customize the bot's behavior, properties, and area.

## License

MIT
