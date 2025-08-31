// index.js — WhatsApp ↔ Kayako bridge
// - Twilio WhatsApp webhook  -> SendGrid email to Kayako (supports media)
// - SendGrid Inbound Parse   -> Twilio WhatsApp outbound (agent replies)
//
// Env (Render):
//   SENDGRID_API_KEY=...               // SendGrid API key
//   MAIL_TO=hello@stickershop.co.uk    // Kayako mailbox
//   MAIL_FROM_DOMAIN=whatsapp.stickershop.co.uk
//   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_WHATSAPP_FROM=whatsapp:+44XXXXXXXXXX        // MUST include whatsapp: prefix
//   (optional) KAYAKO_BASE_URL=https://stickershop.kayako.com
//   (optional) KAYAKO_USERNAME=...     // for subject threading helper
//   (optional) KAYAKO_PASSWORD=...
//   (optional) KAYAKO_FROM_ALLOWLIST=hello@stickershop.co.uk,another@stickershop.co.uk
//   (optional) SG_INBOUND_SECRET=mysecret   // simple inbound auth

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const multer = require('multer');
const twilio = require('twilio');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const SEND_TO      = process.env.MAIL_TO;
const FROM_DOMAIN  = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM      = process.env.TWILIO_WHATSAPP_FROM || '';

const KAYAKO_BASE  = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API   = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER  = process.env.KAYAKO_USERNAME || '';
const KAYAKO_PASS  = process.env.KAYAKO_PASSWORD || '';

const FROM_ALLOW   = (process.env.KAYAKO_FROM_ALLOWLIST || 'hello@stickershop.co.uk')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const INBOUND_SECRET = process.env.SG_INBOUND_SECRET || '';

if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// Validate WA_FROM at boot to catch the common mistake
if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM || '')) {
  console.error('❌ TWILIO_WHATSAPP_FROM must look like "whatsapp:+4479XXXXXXXX". Current value:', WA_FROM);
}

// ---------- Helpers ----------
function kayakoClientOptional() {
  if (!KAYAKO_USER || !KAYAKO_PASS) return null;
  return axios.create({
    baseURL: KAYAKO_API,
    auth: { username: KAYAKO_USER, password: KAYAKO_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

function buildFromAddress(phone) {
  // "whatsapp:+4479..." → "4479...@whatsapp.stickershop.co.uk"
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

function buildSubjectBase(from) {
  return `WhatsApp message from ${from}`;
}

async function findLatestOpenCaseIdByIdentity(email) {
  try {
    const client = kayakoClientOptional();
    if (!client) return null;

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

function firstAddress(str = '') {
  const m = String(str).match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
  return m ? m[1].toLowerCase() : '';
}

function toWhatsAppNumber(toField = '', envelope = '') {
  // Prefer RCPT TO from 'envelope' (SendGrid best source)
  try {
    const env = JSON.parse(envelope || '{}');
    const arr = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
    const to = arr.find(addr => String(addr).toLowerCase().endsWith(`@${FROM_DOMAIN}`)) || arr[0] || '';
    const local = (to || '').split('@')[0];
    const digits = String(local).replace(/\D/g, '');
    return digits ? `whatsapp:+${digits}` : null;
  } catch { /* ignore */ }

  // Fallback: parse the "to" header
  const addr = firstAddress(toField);
  const local = (addr || '').split('@')[0];
  const digits = String(local).replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
}

// ---------- WhatsApp → Kayako (email via SendGrid) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';              // "whatsapp:+4479…"
  const caption = (req.body.Body || '').trim();  // may be empty if only media
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  // Build pseudo "From" identity for Kayako threading per requester
  const fromEmail = buildFromAddress(from);
  const existingCaseId = await findLatestOpenCaseIdByIdentity(fromEmail);

  // Collect attachments from Twilio
  const attachments = [];
  let totalBytes = 0;

  for (let i = 0; i < numMedia; i++) {
    const url  = req.body[`MediaUrl${i}`];
    const type = req.body[`MediaContentType${i}`] || 'application/octet-stream';
    if (!url) continue;

    try {
      const buf = await fetchTwilioMedia(url);
      totalBytes += buf.length;

      // Keep < ~22MB raw (base64 expands to ~30MB SendGrid cap)
      if (totalBytes > 22 * 1024 * 1024) {
        console.warn(`⚠️ Skipping media ${i} to keep email size reasonable.`);
        continue;
      }

      const ext      = guessExt(type);
      const safeNum  = from.replace(/\D/g, '');
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

  const bodyText =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  const subject =
    existingCaseId ? `${buildSubjectBase(from)} [Case #${existingCaseId}]`
                   : buildSubjectBase(from);

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: from },
    subject,
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
    res.type('text/xml').send('<Response></Response>'); // Twilio OK
  } catch (e) {
    console.error('❌ Send failed:', e.response?.body || e.message || e);
    res.status(500).send('SendGrid error');
  }
});

// ---------- SendGrid Inbound Parse → WhatsApp (agent reply back to customer) ----------
const upload = multer({ storage: multer.memoryStorage() });

app.post('/sg-inbound', upload.any(), async (req, res) => {
  try {
    // Optional shared-secret header for simple auth
    if (INBOUND_SECRET) {
      const got = req.headers['x-inbound-secret'];
      if (got !== INBOUND_SECRET) {
        console.warn('⛔️ Inbound secret mismatch');
        return res.status(403).send('forbidden');
      }
    }

    const { from, to, envelope, subject, text, html } = req.body || {};

    const fromAddr = firstAddress(from);
    if (FROM_ALLOW.length && !FROM_ALLOW.includes(fromAddr)) {
      console.log('⛔️ Ignoring email from non-allowlisted sender:', fromAddr);
      return res.status(200).send('ignored');
    }

    const waTo = toWhatsAppNumber(to, envelope);
    if (!waTo) {
      console.log('⛔️ Could not derive WhatsApp number from:', to, envelope);
      return res.status(200).send('no-to');
    }

    // Prefer plain text; fallback to stripped HTML
    let body = (text || '').trim();
    if (!body && html) {
      body = String(html).replace(/<[^>]+>/g, ' ')
                         .replace(/\s+/g, ' ')
                         .trim()
                         .slice(0, 1600);
    }
    if (!body) body = '(no text)';

    // Validate channel pair BEFORE sending
    if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM)) {
      console.error('❌ TWILIO_WHATSAPP_FROM is invalid or missing the "whatsapp:" prefix:', WA_FROM);
      return res.status(500).send('bad-from');
    }
    if (!/^whatsapp:\+\d{6,16}$/.test(waTo)) {
      console.error('❌ Derived WhatsApp "to" is invalid:', waTo);
      return res.status(200).send('bad-to');
    }

    console.log('➡️  Sending via Twilio WhatsApp\n    FROM:', WA_FROM, '\n    TO  :', waTo, '\n    BODY:', body.slice(0, 160));

    const msg = await tClient.messages.create({
      from: WA_FROM,  // e.g. "whatsapp:+44..."
      to: waTo,
      body
      // If you later host attachments publicly, add mediaUrl: ['https://...']
    });

    console.log('✅ Relayed Kayako reply to', waTo, 'SID:', msg.sid, 'Subject:', subject || '(no subject)');
    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ /sg-inbound error:', err.response?.data || err.message || err);
    return res.status(500).send('error');
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));