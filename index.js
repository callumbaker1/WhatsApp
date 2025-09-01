// index.js — WhatsApp ↔ Kayako bridge (thread-safe via RFC headers + subject token)

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
const SERVICE_BASE   = process.env.SERVICE_BASE_URL || ''; // optional override
const MAP_PATH       = process.env.MAP_PATH || '/data/phone_case_map.json'; // persistent map

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Twilio
const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);
if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM || '')) {
  console.error('❌ TWILIO_WHATSAPP_FROM must look like "whatsapp:+4479…". Current:', WA_FROM);
}

// ---------- Persistent phone ➜ {caseId,lastMessageId} map ----------
let phoneMap = {};
try {
  if (fs.existsSync(MAP_PATH)) {
    phoneMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    console.log('📇 Map loaded:', MAP_PATH);
  }
} catch (e) { console.warn('⚠️ Could not load map:', e.message); }

let saveTimer = null;
function saveMapSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
      fs.writeFileSync(MAP_PATH, JSON.stringify(phoneMap, null, 2));
      // console.log('📇 Map saved:', MAP_PATH);
    } catch (e) { console.warn('⚠️ Could not save map:', e.message); }
  }, 200);
}
async function mapGet(key) { return phoneMap[key] || null; }
async function mapSet(key, patch) {
  const cur = phoneMap[key] || {};
  phoneMap[key] = { ...cur, ...patch };
  saveMapSoon();
  return phoneMap[key];
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

// optional seed (first time only)
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

function extractMessageId(headersStr = '') {
  const m = String(headersStr).match(/^message-id:\s*<([^>]+)>/im);
  return m ? `<${m[1]}>` : null; // keep angle brackets
}

// ---------- WhatsApp -> Kayako (email via SendGrid) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const waFrom = req.body.From || '';            // "whatsapp:+4479…"
  const caption = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${waFrom}: ${caption || '(no text)'} — media: ${numMedia}`);

  const fromEmail = buildFromAddress(waFrom);

  // look up per-number mapping
  let mapRow = await mapGet(waFrom);

  // optional: if we have no caseId yet, seed from Kayako (first time only)
  if (!mapRow?.caseId) {
    const seedId = await findLatestOpenCaseIdByIdentity(fromEmail);
    if (seedId) mapRow = await mapSet(waFrom, { caseId: seedId });
  }

  // Collect media
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
      const safeNum  = waFrom.replace(/\D/g, '');
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
      ? `WhatsApp message from ${waFrom} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  // Build subject + RFC headers for threading
  const subject = mapRow?.caseId
    ? `${buildSubjectBase(waFrom)} [Case #${mapRow.caseId}]`
    : buildSubjectBase(waFrom);

  const headers = {
    'Auto-Submitted': 'auto-generated',
    'X-Loop-Prevent': 'whatsapp-bridge'
  };
  if (mapRow?.lastMessageId) {
    headers['In-Reply-To'] = mapRow.lastMessageId;
    headers['References']  = mapRow.lastMessageId;
  }

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: waFrom },
    subject,
    text: bodyText,
    attachments,
    headers
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

// ---------- Temporary file hosting for WhatsApp media (Kayako → WA) ----------
const upload = multer({ storage: multer.memoryStorage() });
const FILE_TTL_MS = 20 * 60 * 1000; // 20 mins
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const memStore = new Map(); // id -> {buf,type,name,exp}

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of memStore) if (v.exp < now) memStore.delete(id);
}, 60 * 1000);

function storeTempFile(buffer, type, name) {
  const id = crypto.randomBytes(16).toString('hex');
  memStore.set(id, { buf: buffer, type: type || 'application/octet-stream', name: name || 'file', exp: Date.now() + FILE_TTL_MS });
  const base = SERVICE_BASE || process.env.RENDER_EXTERNAL_URL || '';
  return `${base}${base.endsWith('/') ? '' : ''}/file/${id}`;
}

app.get('/file/:id', (req, res) => {
  const v = memStore.get(req.params.id);
  if (!v) return res.status(404).send('not found');
  res.setHeader('Content-Type', v.type);
  res.setHeader('Content-Disposition', `inline; filename="${v.name}"`);
  res.send(v.buf);
});

// ---------- Email body cleaning ----------
function stripQuotedAndSignature(txt) {
  if (!txt) return '';
  let s = String(txt).replace(/\r\n/g, '\n');

  // remove quoted '>'
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');

  // "On … wrote:"
  const wroteIdx = s.search(/^\s*On .+ wrote:\s*$/im);
  if (wroteIdx !== -1) s = s.slice(0, wroteIdx);

  // header-ish blocks
  const hdrIdx = s.search(/^\s*(From|Sent|To|Subject):\s/im);
  if (hdrIdx !== -1) s = s.slice(0, hdrIdx);

  // long separator lines (10+ of -, =, _, en dash, em dash)
  const sepMatch = s.match(/^[\t ]*(?:[-=–—_]){10,}[\t ]*$/m);
  if (sepMatch) s = s.slice(0, sepMatch.index);

  // business-card lines (t./m./e./w.)
  const fieldsMatch = s.match(/^\s*(?:t\.|m\.|e\.|w\.)\s+/im);
  if (fieldsMatch) s = s.slice(0, fieldsMatch.index);

  // legal boilerplate
  const legalIdx = s.search(
    /(registered address|company\s*(no|number)|confidential(ity)? notice|this message (is|may be) confidential|please consider the environment)/i
  );
  if (legalIdx !== -1) s = s.slice(0, legalIdx);

  // stray [img ...]
  s = s.replace(/\[img[\s\S]*?\]/gi, ' ');

  // company-specific nukes
  const killPhrases = [/stickershop is a trading division/i, /theprintshop ltd/i];
  for (const rx of killPhrases) {
    const i = s.search(rx);
    if (i !== -1) { s = s.slice(0, i); break; }
  }

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

    const { from, to, envelope, subject, headers: rawHeaders } = req.body || {};
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

    // capture Case # and Message-ID for threading on next inbound email
    const caseIdMatch = (subject || '').match(/\[Case\s*#(\d+)\]/i);
    const caseId = caseIdMatch ? caseIdMatch[1] : null;
    const messageId = extractMessageId(rawHeaders || '');

    let row = await mapGet(waTo);
    row = await mapSet(waTo, {
      caseId: caseId || row?.caseId || null,
      lastMessageId: messageId || row?.lastMessageId || null
    });

    // build clean body
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

    // choose attachments to forward (skip inline)
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
      if (f.size > MAX_MEDIA_BYTES) { console.warn('⚠️ Skipping large attachment:', name, f.size); continue; }
      const url = storeTempFile(f.buffer, f.mimetype, f.originalname);
      mediaUrls.push(url);
      if (mediaUrls.length >= 10) break; // Twilio limit
    }

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