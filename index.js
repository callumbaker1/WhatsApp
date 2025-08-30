// index.js — WhatsApp ➜ Kayako via SendGrid (emails from pseudo-customer)
// ---------------------------------------------------------------
// Env required:
//   SENDGRID_API_KEY=...            // SendGrid API key
//   MAIL_TO=hello@stickershop.co.uk // Your Kayako support inbox address
//   MAIL_FROM_DOMAIN=whatsapp.stickershop.co.uk
//
// Optional (to fetch & attach WhatsApp media):
//   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_AUTH_TOKEN=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
//
// Twilio will POST application/x-www-form-urlencoded to /incoming-whatsapp
// with fields like: From, Body, NumMedia, MediaUrl0, MediaContentType0, etc.

const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const axios = require('axios');

dotenv.config();

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const MAIL_TO = process.env.MAIL_TO; // Kayako support email
const MAIL_FROM_DOMAIN = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';

if (!SENDGRID_API_KEY || !MAIL_TO) {
  console.error('❌ Missing SENDGRID_API_KEY or MAIL_TO env var');
  process.exit(1);
}
sgMail.setApiKey(SENDGRID_API_KEY);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- helpers ----------
const escapeHtml = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

function normalisePhone(whatsFrom = '') {
  // "whatsapp:+4479..." -> "4479..."
  return String(whatsFrom).replace(/^whatsapp:/, '').replace(/^\+/, '');
}

function extFromMime(mime = '') {
  // very light mapping
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf'
  };
  return map[mime.toLowerCase()] || mime.split('/')[1] || 'bin';
}

async function fetchTwilioMediaAsAttachments(reqBody) {
  const attachments = [];
  const notes = [];

  const num = parseInt(reqBody.NumMedia || '0', 10) || 0;
  if (!num) return { attachments, notes };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const canFetch = Boolean(sid && token);

  for (let i = 0; i < Math.min(num, 10); i++) { // sensible cap
    const url = reqBody[`MediaUrl${i}`];
    const type = reqBody[`MediaContentType${i}`] || 'application/octet-stream';
    if (!url) continue;

    if (canFetch) {
      try {
        const resp = await axios.get(url, {
          auth: { username: sid, password: token },
          responseType: 'arraybuffer',
          timeout: 15000
        });
        const b64 = Buffer.from(resp.data).toString('base64');
        const ext = extFromMime(type);
        attachments.push({
          content: b64,
          filename: `whatsapp-media-${i + 1}.${ext}`,
          type,
          disposition: 'attachment'
        });
      } catch (err) {
        notes.push(`(Could not fetch media ${i + 1}: ${err.message})`);
      }
    } else {
      // If we can't fetch, include a note (Twilio URLs are short-lived & require auth).
      notes.push(`(Media ${i + 1}: ${type} — configure TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN to attach)`);
    }
  }

  return { attachments, notes };
}

// ---------- webhook ----------
app.post('/incoming-whatsapp', async (req, res) => {
  try {
    const from = req.body.From || '';    // e.g. "whatsapp:+4479..."
    const text = req.body.Body || '';
    const phone = normalisePhone(from);

    console.log(`📩 WhatsApp from ${from}: ${text}`);

    const pseudoFrom = `${phone}@${MAIL_FROM_DOMAIN}`;
    const { attachments, notes } = await fetchTwilioMediaAsAttachments(req.body);

    const htmlBody =
      `<p><strong>WhatsApp from ${escapeHtml(phone)}</strong></p>` +
      `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` +
      (notes.length ? `<hr><p><em>${notes.map(escapeHtml).join('<br>')}</em></p>` : '');

    const msg = {
      to: MAIL_TO,
      from: { email: pseudoFrom, name: `WhatsApp ${phone}` },
      replyTo: { email: pseudoFrom, name: `WhatsApp ${phone}` },
      subject: `WhatsApp chat from ${phone}`,
      text,
      html: htmlBody,
      attachments,
      headers: {
        'X-WhatsApp-Phone': phone
      }
    };

    await sgMail.send(msg);
    console.log(`✉️  Emailed to Kayako as ${pseudoFrom} → ${MAIL_TO} (attachments: ${attachments.length})`);

    // Twilio only needs 200 OK; empty TwiML is fine.
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('❌ Send failed:', err?.response?.body || err.message);
    res.status(500).send('Email send failed');
  }
});

// ---------- health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server on :${PORT}`));