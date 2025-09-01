// index.js — WhatsApp ↔ Kayako bridge (with phone→case mapping)
// WA inbound -> SendGrid email to Kayako (plus-address threading)
// SendGrid inbound -> WA outbound (cleans signatures, relays attachments)
// Mapping: simple JSON file { "<digits>": <caseId> } to keep threads stable.
//
// Requires (already in your project):
//   npm i express body-parser axios dotenv @sendgrid/mail multer twilio

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
const sgMail = require('@sendgrid/mail');
const multer = require('multer');
const twilio = require('twilio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Config ----------
const SEND_TO      = process.env.MAIL_TO;                        // e.g. hello@stickershop.co.uk
const FROM_DOMAIN  = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM      = process.env.TWILIO_WHATSAPP_FROM || '';     // e.g. whatsapp:+44XXXX

const KAYAKO_BASE  = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API   = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER  = process.env.KAYAKO_USERNAME || '';
const KAYAKO_PASS  = process.env.KAYAKO_PASSWORD || '';

const FROM_ALLOW   = (process.env.KAYAKO_FROM_ALLOWLIST || 'hello@stickershop.co.uk')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const INBOUND_SECRET = process.env.SG_INBOUND_SECRET || '';
const SERVICE_BASE   = process.env.SERVICE_BASE_URL || ''; // public URL; if blank, Render will inject RENDER_EXTERNAL_URL

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Twilio
const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);
if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM || '')) {
  console.error('❌ TWILIO_WHATSAPP_FROM must look like "whatsapp:+4479…". Current:', WA_FROM);
}

// ---------- Mapping store (JSON file) ----------
const MAP_PATH = process.env.MAP_PATH || path.join(__dirname, 'phone_case_map.json');

function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveMap(map) {
  try {
    const tmp = MAP_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, MAP_PATH);
  } catch (e) {
    console.warn('⚠️ Could not persist mapping:', e.message);
  }
}
let PHONE_CASE_MAP = loadMap();

function phoneDigits(waFrom) {
  return String(waFrom || '').replace(/^whatsapp:/, '').replace(/[^\d]/g, '');
}
function setMapping(waFrom, caseId) {
  const key = phoneDigits(waFrom);
  if (!key || !caseId) return;
  if (String(PHONE_CASE_MAP[key]) === String(caseId)) return; // unchanged
  PHONE_CASE_MAP[key] = caseId;
  saveMap(PHONE_CASE_MAP);
  console.log('🔗 Mapping saved:', key, '→', caseId);
}
function getMapping(waFrom) {
  const key = phoneDigits(waFrom);
  return key ? PHONE_CASE_MAP[key] : undefined;
}
function clearMapping(waFrom) {
  const key = phoneDigits(waFrom);
  if (key && PHONE_CASE_MAP[key]) {
    delete PHONE_CASE_MAP[key];
    saveMap(PHONE_CASE_MAP);
  }
}

// ---------- Kayako helper (read-only) ----------
function kayakoClientOptional() {
  if (!KAYAKO_USER || !KAYAKO_PASS) return null;
  return axios.create({
    baseURL: KAYAKO_API,
    auth: { username: KAYAKO_USER, password: KAYAKO_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

// Find the latest OPEN case for this pseudo identity email
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

// ---------- Shared helpers ----------
function buildFromAddress(waFrom) {
  const num = phoneDigits(waFrom);
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
function subjectBase(waFrom) {
  return `WhatsApp message from ${waFrom}`;
}
function plusAddress(baseEmail, caseId) {
  const [local, domain] = String(baseEmail).split('@');
  if (!local || !domain || !caseId) return baseEmail;
  return `${local}+${caseId}@${domain}`;
}

// ---------- WhatsApp -> Kayako (email via SendGrid, threaded) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const waFrom = req.body.From || '';
  const caption = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${waFrom}: ${caption || '(no text)'} — media: ${numMedia}`);

  const pseudoEmail = buildFromAddress(waFrom);

  // Step 1: mapping (fast path)
  let caseId = getMapping(waFrom);

  // Step 2: if no mapping yet, try to discover an open case in Kayako for this identity
  if (!caseId) {
    caseId = await findLatestOpenCaseIdByIdentity(pseudoEmail);
    if (caseId) setMapping(waFrom, caseId);
  }

  // Gather attachments
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
      const ext = guessExt(type);
      const safeNum = phoneDigits(waFrom);
      attachments.push({
        content: buf.toString('base64'),
        filename: `${safeNum}-wa-${i + 1}${ext}`,
        type,
        disposition: 'attachment'
      });
    } catch (err) {
      console.error(`❌ Failed to fetch media ${i}:`, err.response?.status || err.message);
    }
  }

  const textBody =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${waFrom} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  // Build To and Subject
  const baseSubject = subjectBase(waFrom);
  const toMailbox = caseId ? plusAddress(SEND_TO, caseId) : SEND_TO;
  const subject = caseId ? `${baseSubject} [Case #${caseId}]` : baseSubject;

  const msg = {
    to: toMailbox,
    from: { email: pseudoEmail, name: waFrom },
    subject,
    text: textBody,
    attachments,
    headers: {
      'Auto-Submitted': 'auto-generated',
      'X-Loop-Prevent': 'whatsapp-bridge'
    }
  };

  try {
    await sgMail.send(msg);
    console.log(`✉️  Emailed to Kayako as ${msg.from.email} → ${toMailbox} (attachments: ${attachments.length})`);

    // Step 3: If this was the first message (no mapping), try to fetch the newly created case ID now
    if (!caseId) {
      const found = await findLatestOpenCaseIdByIdentity(pseudoEmail);
      if (found) setMapping(waFrom, found);
    }

    res.type('text/xml').send('<Response></Response>'); // Twilio OK
  } catch (e) {
    console.error('❌ Send failed:', e.response?.body || e.message || e);
    res.status(500).send('SendGrid error');
  }
});

// ---------- Temporary file hosting for WhatsApp media (inbound → outbound) ----------
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
  memStore.set(id, {
    buf: buffer,
    type: type || 'application/octet-stream',
    name: name || 'file',
    exp: Date.now() + FILE_TTL_MS
  });
  const base = SERVICE_BASE || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
  const origin = base || '';
  return `${origin}${origin.endsWith('/') ? '' : ''}/file/${id}`;
}

app.get('/file/:id', (req, res) => {
  const v = memStore.get(req.params.id);
  if (!v) return res.status(404).send('not found');
  res.setHeader('Content-Type', v.type);
  res.setHeader('Content-Disposition', `inline; filename="${v.name}"`);
  res.send(v.buf);
});

// ---------- Email cleaning (agent reply → WhatsApp) ----------
function stripQuotedAndSignature(txt) {
  if (!txt) return '';
  let s = String(txt).replace(/\r\n/g, '\n');

  // remove quoted history
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');

  // cut at “On … wrote:”
  const wroteIdx = s.search(/^\s*On .+ wrote:\s*$/im);
  if (wroteIdx !== -1) s = s.slice(0, wroteIdx);

  // cut at From/Sent/To/Subject header block
  const hdrIdx = s.search(/^\s*(From|Sent|To|Subject):\s/im);
  if (hdrIdx !== -1) s = s.slice(0, hdrIdx);

  // separator lines (10+ of -, =, _, en dash, em dash)
  const sepMatch = s.match(/^[\t ]*(?:[-=–—_]){10,}[\t ]*$/m);
  if (sepMatch) s = s.slice(0, sepMatch.index);

  // phone/email/web “fields” like: t. / m. / e. / w.
  const fieldsMatch = s.match(/^\s*(?:t\.|m\.|e\.|w\.)\s+/im);
  if (fieldsMatch) s = s.slice(0, fieldsMatch.index);

  // legal/disclaimer phrases
  const legalIdx = s.search(
    /(registered address|company\s*(no|number)|confidential(ity)? notice|this message (is|may be) confidential|please consider the environment)/i
  );
  if (legalIdx !== -1) s = s.slice(0, legalIdx);

  // strip stray [img ...] blocks
  s = s.replace(/\[img[\s\S]*?\]/gi, ' ');

  // company-specific
  const killPhrases = [/stickershop is a trading division/i, /theprintshop ltd/i];
  for (const rx of killPhrases) {
    const i = s.search(rx);
    if (i !== -1) { s = s.slice(0, i); break; }
  }

  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 1600) s = s.slice(0, 1590) + '…';
  return s;
}

// ---------- SendGrid Inbound Parse -> WhatsApp (agent replies) ----------
function firstAddress(str = '') {
  const m = String(str).match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
  return m ? m[1].toLowerCase() : '';
}
function toWhatsAppNumber(toField = '', envelope = '') {
  // Prefer RCPT TO from envelope first
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
      body = String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
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

    const inlineNames = new Set(
      Object.values(info)
        .filter(meta => /inline/i.test(meta.disposition || '') || meta['content-id'])
        .map(meta => (meta.filename || '').toLowerCase())
    );

    for (const f of req.files || []) {
      const name = (f.originalname || 'file').toLowerCase();
      if (inlineNames.has(name)) continue;
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