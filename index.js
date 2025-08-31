// index.js — WhatsApp ↔ Kayako bridge (clean replies + attachment relay)
// Twilio inbound -> SendGrid email to Kayako
// SendGrid inbound -> Twilio WhatsApp (strip signatures/quotes, host attachments)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const multer = require('multer');
const twilio = require('twilio');
const crypto = require('crypto');

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
const SERVICE_BASE   = process.env.SERVICE_BASE_URL || ''; // optional override (otherwise derived)

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Twilio
const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);
if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM || '')) {
  console.error('❌ TWILIO_WHATSAPP_FROM must look like "whatsapp:+4479…". Current:', WA_FROM);
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
  return map[(contentType || '').toLowerCase()] || '';
}

async function fetchTwilioMedia(url) {
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
  // Try RCPT TO from SendGrid's envelope first
  try {
    const env = JSON.parse(envelope || '{}');
    const arr = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
    const to = arr.find(a => String(a).toLowerCase().endsWith(`@${FROM_DOMAIN}`)) || arr[0] || '';
    const digits = String((to || '').split('@')[0]).replace(/\D/g, '');
    return digits ? `whatsapp:+${digits}` : null;
  } catch { /* ignore */ }

  // Fallback to the "to" header
  const addr = firstAddress(toField);
  const digits = String((addr || '').split('@')[0]).replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
}

// ---------- WhatsApp -> Kayako (email via SendGrid) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const caption = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

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
        console.warn(`⚠️ Skipping media ${i} to stay under email limit`);
        continue;
      }

      const ext      = guessExt(type);
      const safeNum  = from.replace(/\D/g, '');
      const filename = `${safeNum}-wa-${i + 1}${ext}`;
      const b64      = buf.toString('base64');

      attachments.push({ content: b64, filename, type, disposition: 'attachment' });
    } catch (err) {
      console.error(`❌ Failed to fetch media ${i}:`, err.response?.status || err.message);
    }
  }

  const bodyText =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  const subject = existingCaseId
    ? `${buildSubjectBase(from)} [Case #${existingCaseId}]`
    : buildSubjectBase(from);

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: from },
    subject,
    text: bodyText,
    attachments,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Loop-Prevent': 'whatsapp-bridge' }
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

// ---------- Temporary file hosting for WhatsApp media ----------
const upload = multer({ storage: multer.memoryStorage() });
const FILE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // per file safeguard (10MB)
const memStore = new Map(); // id -> {buf,type,name,exp}

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of memStore) if (v.exp < now) memStore.delete(id);
}, 60 * 1000);

function storeTempFile(buffer, type, name) {
  const id = crypto.randomBytes(16).toString('hex');
  memStore.set(id, { buf: buffer, type: type || 'application/octet-stream', name: name || 'file', exp: Date.now() + FILE_TTL_MS });
  const base = SERVICE_BASE || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  const origin = base || ''; // If unset, rely on the public Render URL populated at runtime
  return `${origin}${origin.endsWith('/') ? '' : ''}/file/${id}`;
}

app.get('/file/:id', (req, res) => {
  const v = memStore.get(req.params.id);
  if (!v) return res.status(404).send('not found');
  res.setHeader('Content-Type', v.type);
  res.setHeader('Content-Disposition', `inline; filename="${v.name}"`);
  res.send(v.buf);
});

// ---------- Email cleaning ----------
function stripQuotedAndSignature(txt) {
  if (!txt) return '';

  let s = txt.replace(/\r\n/g, '\n');

  // Remove lines starting with ">" (quoted)
  s = s.split('\n').filter(line => !/^\s*>/.test(line)).join('\n');

  // Cut at the Gmail style "On … wrote:" line
  s = s.split('\n').reduce((acc, line) => {
    if (/^On .+ wrote:$/i.test(line.trim())) return acc; // stop collecting
    if (acc !== null) return acc + line + '\n';
    return acc;
  }, '');

  // If above reducer stopped early it would return string, else null; ensure string
  if (s == null) s = txt;

  // Cut at classic signature delimiter: "-- " on its own line
  const sigIdx = s.indexOf('\n-- \n');
  if (sigIdx !== -1) s = s.slice(0, sigIdx);

  // Chop common Outlook reply header block
  const hdrIdx = s.search(/\nFrom:\s|^\s*From:\s/im);
  if (hdrIdx !== -1) s = s.slice(0, hdrIdx);

  // Remove any [img ...] blocks that sometimes appear
  s = s.replace(/\[img[\s\S]*?\]/gi, ' ');

  // Collapse whitespace and limit length for WhatsApp
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 1600) s = s.slice(0, 1590) + '…';

  return s;
}

// ---------- SendGrid Inbound Parse -> WhatsApp ----------
app.post('/sg-inbound', upload.any(), async (req, res) => {
  try {
    if (INBOUND_SECRET) {
      const got = req.headers['x-inbound-secret'];
      if (got !== INBOUND_SECRET) {
        console.warn('⛔️ Inbound secret mismatch');
        return res.status(403).send('forbidden');
      }
    }

    const { from, to, envelope, subject } = req.body || {};
    let { text, html } = req.body || {};

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

    // Clean body
    let body = (text || '').trim();
    if (!body && html) {
      // very basic HTML strip
      body = String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/&nbsp;/gi, ' ')
                         .replace(/\s+/g, ' ')
                         .trim();
    }
    body = stripQuotedAndSignature(body);
    if (!body) body = '(no text)';

    // Decide which attachments to forward (ignore inline signature images)
    const mediaUrls = [];
    let info = {};
    try { info = JSON.parse(req.body['attachment-info'] || '{}'); } catch {}

    // Map filename -> meta to decide inline vs attachment
    const inlineNames = new Set(
      Object.values(info)
        .filter(meta => /inline/i.test(meta.disposition || '') || meta['content-id'])
        .map(meta => (meta.filename || '').toLowerCase())
    );

    for (const f of req.files || []) {
      const name = (f.originalname || 'file').toLowerCase();
      if (inlineNames.has(name)) {
        // Skip inline/logo
        continue;
      }
      if (f.size > MAX_MEDIA_BYTES) {
        console.warn('⚠️ Skipping large attachment:', name, f.size);
        continue;
      }
      const url = storeTempFile(f.buffer, f.mimetype, f.originalname);
      mediaUrls.push(url);
      if (mediaUrls.length >= 10) break; // Twilio limit
    }

    // Validate channels before sending
    if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM)) {
      console.error('❌ TWILIO_WHATSAPP_FROM invalid:', WA_FROM);
      return res.status(500).send('bad-from');
    }
    if (!/^whatsapp:\+\d{6,16}$/.test(waTo)) {
      console.error('❌ Derived WhatsApp "to" invalid:', waTo);
      return res.status(200).send('bad-to');
    }

    console.log('➡️  Twilio send\n    FROM:', WA_FROM, '\n    TO  :', waTo, '\n    BODY:', body.slice(0, 160), '\n    media:', mediaUrls.length);

    const payload = { from: WA_FROM, to: waTo, body };
    if (mediaUrls.length) payload.mediaUrl = mediaUrls;

    const msg = await tClient.messages.create(payload);
    console.log('✅ Relayed to WhatsApp SID:', msg.sid, 'Subject:', subject || '(no subject)');

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