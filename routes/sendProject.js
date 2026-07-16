const fs = require('fs');
const path = require('path');
const projects = require('../config/projects');

function validatePhone(phone) {
  const digits = phone.replace(/\D/g, '');
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

async function sendProjectAssets(sock, phone, projectName) {
  const project = projects[projectName];
  if (!project) {
    return { success: false, message: 'Unknown project' };
  }

  const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;

  const textMsg = `🏡 Bhoomi Space

Thank you for your interest in ${projectName} Township.

I've shared the project brochure and project poster with you.

If you have any questions, you can continue speaking with our AI Sales Consultant or reply here on WhatsApp.`;

  await sock.sendMessage(jid, { text: textMsg });

  if (project.poster) {
    const posterPath = path.join(__dirname, '..', project.poster);
    if (fs.existsSync(posterPath)) {
      try {
        const posterBuf = fs.readFileSync(posterPath);
        await sock.sendMessage(jid, {
          image: posterBuf,
          caption: `📸 ${projectName} - Poster`,
          mimetype: 'image/jpeg'
        });
      } catch (e) {
        console.log(`Failed to send poster for ${projectName}: ${e.message}`);
      }
    }
  }

  if (project.brochure) {
    const brochurePath = path.join(__dirname, '..', project.brochure);
    if (fs.existsSync(brochurePath)) {
      try {
        const brochureBuf = fs.readFileSync(brochurePath);
        await sock.sendMessage(jid, {
          document: brochureBuf,
          caption: `📄 ${projectName} - Brochure`,
          mimetype: 'application/pdf',
          fileName: `${projectName}-Brochure.pdf`
        });
      } catch (e) {
        console.log(`Failed to send brochure for ${projectName}: ${e.message}`);
      }
    }
  }

  return { success: true, message: `Project details sent for ${projectName}` };
}

module.exports = { sendProjectAssets, validatePhone };
