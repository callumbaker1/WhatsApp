// index.js — WhatsApp → Kayako via SendGrid (threads to existing case by subject token)
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const SEND_TO       = process.env.MAIL_TO;                          // e.g. hello@stickershop.co.uk
const FROM_DOMAIN   = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

const KAYAKO_BASE   = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API    = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER   = process.env.KAYAKO_USERNAME;
const KAYAKO_PASS   = process.env.KAYAKO_PASSWORD;

if (!process.env.SENDGRID_API_KEY) {
  console.error('❌ Missing SENDGRID_API_KEY'); // will crash when used
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---------- Helpers ----------
function kayakoClient() {
  // For simple GETs we can use HTTP Basic; no CSRF needed.
  return axios.create({
    baseURL: KAYAKO_API,
    auth: { username: KAYAKO_USER, password: KAYAKO_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

function buildFromAddress(phone) {
  // phone like "whatsapp:+4479..." → "4479...@whatsapp.stickershop.co.uk"
  const num = String(phone || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  return `${num}@${FROM_DOMAIN}`;
}

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

function buildSubject(from, caseId) {
  const base = `WhatsApp message from ${from}`;
  return caseId ? `${base} [Case #${caseId}]` : base;
}

// Find the latest open case for this identity (the pseudo email we send from)
async function findLatestOpenCaseIdByIdentity(email) {
  try {
    const client = kayakoClient();
    // identity_type/value + status filter; most-recent by updated_at
    const r = await client.get('/cases.json', {
      params: {
        identity_type: 'EMAIL',
        identity_value: email,
        status: 'NEW,OPEN,PENDING',
        limit: 1,
        sort: 'updated_at',
        order: 'desc'
      }
    });
    const id = r.data?.data?.[0]?.id || null;
    if (id) console.log('🔎 Found open case for identity:', id);
    return id;
  } catch (e) {
    console.warn('⚠️ Case lookup failed:', e.response?.data || e.message);
    return null;
  }
}

// ---------- Webhook ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from      = req.body.From || '';              // "whatsapp:+4479…"
  const caption   = (req.body.Body || '').trim();     // may be empty if only media
  const numMedia  = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  // Build "From" email used to create/identify the requester
  const fromEmail = buildFromAddress(from);

  // Try to find an existing case for this identity so we can thread by subject
  const existingCaseId = await findLatestOpenCaseIdByIdentity(fromEmail);

  // Collect attachments
  const attachments = [];
  let totalBytes = 0;

  for (let i = 0; i < numMedia; i++) {
    const url  = req.body[`MediaUrl${i}`];
    const type = req.body[`MediaContentType${i}`] || 'application/octet-stream';
    if (!url) continue;

    try {
      const buf = await fetchTwilioMedia(url);
      totalBytes += buf.length;

      // Keep below ~22MB raw to stay under SendGrid's ~30MB base64 limit
      if (totalBytes > 22 * 1024 * 1024) {
        console.warn(`⚠️ Skipping media ${i} to keep email size reasonable.`);
        continue;
      }

      const ext     = guessExt(type);
      const safeNum = from.replace(/\D/g, '');
      const filename = `${safeNum}-wa-${i + 1}${ext}`;
      const b64      = buf.toString('base64');

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

  // Ensure SendGrid has at least one char of text
  const bodyText =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  const msg = {
    to: SEND_TO,                                 // Kayako mailbox
    from: { email: fromEmail, name: from },      // pseudo-identity (customer)
    subject: buildSubject(from, existingCaseId), // add [Case #123456] if found
    text: bodyText,
    attachments,
    // Some loop-safety headers (Kayako usually ignores these, but harmless):
    headers: {
      'Auto-Submitted': 'auto-generated',
      'X-Loop-Prevent': 'whatsapp-bridge'
    }
  };

  try {
    await sgMail.send(msg);
    console.log(
      `✉️  Emailed to Kayako as ${msg.from.email} → ${SEND_TO} (attachments: ${attachments.length})`
    );
    // Twilio expects a 200 with (empty) TwiML
    res.type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error('❌ Send failed:', e.response?.body || e.message || e);
    res.status(500).send('SendGrid error');
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));