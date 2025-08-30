// index.js — WhatsApp → Kayako via SendGrid (supports media attachments)
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Config ---
const SEND_TO = process.env.MAIL_TO;                              // e.g. hello@stickershop.co.uk
const FROM_DOMAIN = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

if (!process.env.SENDGRID_API_KEY) {
  console.error('Missing SENDGRID_API_KEY');
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// --- Helpers ---
function guessExt(contentType = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'text/plain': '.txt'
  };
  return map[contentType.toLowerCase()] || '';
}

async function fetchTwilioMedia(url) {
  // Twilio media URLs require basic auth with SID/TOKEN
  const resp = await axios.get(url, {
    auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
    responseType: 'arraybuffer',
    timeout: 30000
  });
  return Buffer.from(resp.data);
}

function buildFromAddress(phone) {
  // phone like +4479… → 4479…@whatsapp.stickershop.co.uk
  const num = String(phone || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  return `${num}@${FROM_DOMAIN}`;
}

// --- Webhook ---
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const caption = (req.body.Body || '').trim(); // may be empty when sending only media
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  // Collect attachments
  const attachments = [];
  let totalBytes = 0;

  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`];
    const type = req.body[`MediaContentType${i}`] || 'application/octet-stream';
    if (!url) continue;

    try {
      const buf = await fetchTwilioMedia(url);
      totalBytes += buf.length;

      // Soft limit to avoid SendGrid’s ~30MB per message cap (Base64 inflates by ~33%)
      if (totalBytes > 22 * 1024 * 1024) {
        console.warn(`⚠️ Skipping media ${i} to keep email size reasonable.`);
        continue;
      }

      const ext = guessExt(type);
      const safeNum = from.replace(/\D/g, '');
      const filename = `${safeNum}-wa-${i + 1}${ext}`;
      const b64 = buf.toString('base64');

      attachments.push({
        content: b64,
        filename,
        type,
        disposition: 'attachment'
      });
    } catch (err) {
      console.error(`❌ Failed to fetch media ${i}:`, err.response?.status || err.message);
    }
  }

  // Ensure we send at least one character of text (SendGrid requirement)
  let text = caption;
  if (!text) {
    text = attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).';
  }

  const msg = {
    to: SEND_TO,
    from: buildFromAddress(from),
    subject: `WhatsApp ${from}`,
    text,
    attachments
  };

  try {
    await sgMail.send(msg);
    console.log(
      `✉️  Emailed to Kayako as ${msg.from} → ${SEND_TO} (attachments: ${attachments.length})`
    );
    res.type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error('❌ Send failed:', e.response?.body || e.message || e);
    res.status(500).send('SendGrid error');
  }
});

// Health
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));