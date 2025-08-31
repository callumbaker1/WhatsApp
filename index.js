// index.js — WhatsApp <-> Kayako bridge
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const SEND_TO       = process.env.MAIL_TO;                          // e.g. hello@stickershop.co.uk
const FROM_DOMAIN   = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TW_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;          // e.g. 'whatsapp:+44...'
const tClient       = twilio(TWILIO_SID, TWILIO_TOKEN);

const KAYAKO_BASE   = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API    = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER   = process.env.KAYAKO_USERNAME;
const KAYAKO_PASS   = process.env.KAYAKO_PASSWORD;

if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---------- Helpers ----------
function kayakoClient() {
  return axios.create({
    baseURL: KAYAKO_API,
    auth: { username: KAYAKO_USER, password: KAYAKO_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

function buildFromAddress(phone) {
  const num = String(phone || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  return `${num}@${FROM_DOMAIN}`;
}

function extractPhoneFromPseudoEmail(email) {
  // matches 4479...@whatsapp.stickershop.co.uk
  const m = String(email || '').trim().match(/^(\d+)\@([^@]+)$/i);
  if (!m) return null;
  // optionally check domain:
  // if (!m[2].toLowerCase().endsWith(FROM_DOMAIN.toLowerCase())) return null;
  return `whatsapp:+${m[1]}`;
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

async function findLatestOpenCaseIdByIdentity(email) {
  try {
    const client = kayakoClient();
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

// ---------- WhatsApp -> Kayako (email in) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from      = req.body.From || '';
  const caption   = (req.body.Body || '').trim();
  const numMedia  = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  const fromEmail = buildFromAddress(from);
  const existingCaseId = await findLatestOpenCaseIdByIdentity(fromEmail);

  const attachments = [];
  let totalBytes = 0;

  for (let i = 0; i < numMedia; i++) {
    const url  = req.body[`MediaUrl${i}`];
    const type = req.body[`MediaContentType${i}`] || 'application/octet-stream';
    if (!url) continue;

    try {
      const buf = await fetchTwilioMedia(url);
      totalBytes += buf.length;
      if (totalBytes > 22 * 1024 * 1024) {
        console.warn(`⚠️ Skipping media ${i} to keep email size reasonable.`);
        continue;
      }
      const ext     = guessExt(type);
      const safeNum = from.replace(/\D/g, '');
      const filename = `${safeNum}-wa-${i + 1}${ext}`;
      attachments.push({
        content: buf.toString('base64'),
        filename,
        type,
        disposition: 'attachment'
      });
    } catch (err) {
      console.error(`❌ Failed to fetch media ${i}:`, err.response?.status || err.message);
    }
  }

  const bodyText =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: from },
    subject: buildSubject(from, existingCaseId),
    text: bodyText,
    attachments,
    headers: {
      'Auto-Submitted': 'auto-generated',
      'X-Loop-Prevent': 'whatsapp-bridge'
    }
  };

  try {
    await sgMail.send(msg);
    console.log(`✉️  Emailed to Kayako as ${msg.from.email} → ${SEND_TO} (attachments: ${attachments.length})`);
    res.type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error('❌ Send failed:', e.response?.body || e.message || e);
    res.status(500).send('SendGrid error');
  }
});

// ---------- Kayako -> WhatsApp (reply out) ----------
app.post('/kayako-outbound', async (req, res) => {
  try {
    // Be very tolerant about structures from Kayako Automations
    const b = req.body || {};
    const text =
      b.message || b.contents || b.text || b.plain_body ||
      b.post?.plain_body || b.post?.body || '';

    const requesterEmail =
      b.requester_email || b.email || b.from_email ||
      b.case?.requester?.email || b.requester?.email || '';

    // You can also allow Kayako to pass the number explicitly:
    const explicitTo =
      b.to || b.phone || b.whatsapp_to || b.requester_phone || '';

    console.log('🔔 Kayako webhook body:', JSON.stringify(b, null, 2));

    // Basic validation
    if (!text || !text.trim()) {
      return res.status(200).json({ ok: false, error: 'bad_payload', why: 'missing_text' });
    }

    // Work out the WhatsApp destination
    let toWhatsApp = '';
    if (explicitTo && /^(\+?\d+)$/.test(String(explicitTo))) {
      toWhatsApp = 'whatsapp:' + explicitTo.replace(/^whatsapp:/, '').replace(/^\+?/, '+');
    } else {
      const fromPseudo = requesterEmail && extractPhoneFromPseudoEmail(requesterEmail);
      if (fromPseudo) toWhatsApp = fromPseudo;
    }

    if (!toWhatsApp) {
      return res.status(200).json({ ok: false, error: 'bad_payload', why: 'missing_destination' });
    }
    if (!TW_WHATSAPP_FROM) {
      return res.status(500).json({ ok: false, error: 'server_misconfig', why: 'TWILIO_WHATSAPP_FROM missing' });
    }

    // Send via Twilio WhatsApp
    const resp = await tClient.messages.create({
      from: TW_WHATSAPP_FROM,
      to: toWhatsApp,
      body: text.trim()
    });

    console.log('➡️  Sent WhatsApp:', { sid: resp.sid, to: toWhatsApp });
    return res.status(200).json({ ok: true, sid: resp.sid });
  } catch (err) {
    console.error('❌ Outbound error:', err.response?.data || err.message || err);
    return res.status(500).json({ ok: false, error: 'exception' });
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));