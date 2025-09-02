// index.js — WhatsApp ↔ Kayako bridge (solid header-threading + clean replies + attachment relay)
//
// Flow A: Twilio inbound  -> SendGrid email to Kayako
//   - Builds From: <digits>@whatsapp.stickershop.co.uk
//   - If we have Kayako Message-ID, sets In-Reply-To/References to that
//   - If we know Case #, adds [Case #N] to subject (nice-to-have)
//   - Stores last outbound SendGrid X-Message-Id (debug only)
//
// Flow B: SendGrid Inbound Parse -> Twilio WhatsApp
//   - Strips signatures/quotes
//   - Relays attachments via temporary URLs
//   - On emails coming **from Kayako**, records Kayako Message-ID + Case # for future threading
//
// NOTE: Requires a persistent disk if you want threading to survive deploys.
//   MAP_PATH=/data/thread_map.json  (default)

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
const SEND_TO      = process.env.MAIL_TO;                           // e.g. hello@stickershop.co.uk
const FROM_DOMAIN  = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WA_FROM      = process.env.TWILIO_WHATSAPP_FROM || '';       // e.g. "whatsapp:+44..."

const KAYAKO_BASE  = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API   = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER  = process.env.KAYAKO_USERNAME || '';
const KAYAKO_PASS  = process.env.KAYAKO_PASSWORD || '';

const FROM_ALLOW   = (process.env.KAYAKO_FROM_ALLOWLIST || 'hello@stickershop.co.uk')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const INBOUND_SECRET = process.env.SG_INBOUND_SECRET || '';
const SERVICE_BASE   = process.env.SERVICE_BASE_URL || ''; // optional public base for /file URLs
const MAP_PATH       = process.env.MAP_PATH || '/data/thread_map.json'; // persistent state

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Twilio
const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);
if (!/^whatsapp:\+\d{6,16}$/.test(WA_FROM || '')) {
  console.error('❌ TWILIO_WHATSAPP_FROM must look like "whatsapp:+4479…". Current:', WA_FROM);
}

// ---------- Small helpers ----------
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

function waKey(input) {
  const digits = String(input || '').replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
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

// ----- Persistent map: { "whatsapp:+4479...": { caseId?, kayakoMsgId?, lastOutboundSgId?, updatedAt } } -----
function loadThreadMap() {
  try { return JSON.parse(fs.readFileSync(MAP_PATH, 'utf8')); }
  catch { return {}; }
}
function saveThreadMap(map) {
  try {
    fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
    fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
  } catch (e) { console.warn('⚠️ saveThreadMap failed:', e.message); }
}

// Migrate old digits-only keys -> canonical whatsapp:+<digits>
function migrateKeyIfNeeded(map, numberLike) {
  const key = waKey(numberLike);
  if (!key) return key;
  const digits = String(numberLike || '').replace(/\D/g, '');
  if (digits && map[digits] && !map[key]) {
    map[key] = map[digits];
    delete map[digits];
    saveThreadMap(map);
  }
  return key;
}

// Optional fallback: ask Kayako for current open case for this identity
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
  // Prefer RCPT TO from SendGrid envelope
  try {
    const env = JSON.parse(envelope || '{}');
    const arr = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
    const to = arr.find(a => String(a).toLowerCase().endsWith(`@${FROM_DOMAIN}`)) || arr[0] || '';
    const digits = String((to || '').split('@')[0]).replace(/\D/g, '');
    return digits ? `whatsapp:+${digits}` : null;
  } catch {}
  // Fallback: parse "to" header
  const addr = firstAddress(toField);
  const digits = String((addr || '').split('@')[0]).replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
}

function getHeader(raw, name) {
  const re = new RegExp(`^${name}:(.*)$`, 'im');
  const m = String(raw || '').match(re);
  return m ? m[1].trim() : '';
}

// ---------- WhatsApp -> Kayako (email via SendGrid) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const caption = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  const fromEmail = buildFromAddress(from);

  // Load and migrate state keys if needed
  const threadMap = loadThreadMap();
  const key = migrateKeyIfNeeded(threadMap, from);
  const meta = key ? (threadMap[key] || {}) : {};

  // Optional: if we don't yet have a caseId, try to discover one to help Kayako
  if (!meta.caseId) {
    const maybeCase = await findLatestOpenCaseIdByIdentity(fromEmail);
    if (maybeCase) {
      meta.caseId = String(maybeCase);
      meta.updatedAt = Date.now();
      threadMap[key] = meta;
      saveThreadMap(threadMap);
    }
  }

  // Gather Twilio media
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

  // Subject: add [Case #] if we know it (helps Kayako)
  const subject = meta.caseId
    ? `${buildSubjectBase(from)} [Case #${meta.caseId}]`
    : buildSubjectBase(from);

  // Build headers — ONLY use Kayako Message-ID for threading
  const headers = {
    'Auto-Submitted': 'auto-generated',
    'X-Loop-Prevent': 'whatsapp-bridge'
  };
  if (meta.kayakoMsgId && /@/.test(meta.kayakoMsgId)) {
    headers['In-Reply-To'] = meta.kayakoMsgId;
    headers['References']  = meta.kayakoMsgId;
  }

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: from },
    subject,
    text: bodyText,
    attachments,
    headers
  };

  try {
    const [resp] = await sgMail.send(msg);

    // Save outbound SendGrid id (debug only; not used for threading)
    const outId = (resp && resp.headers && (
      resp.headers['x-message-id'] ||
      resp.headers['X-Message-Id'] ||
      resp.headers['X-Message-ID']
    )) || null;

    if (key) {
      const map = loadThreadMap();
      const cur = map[key] || {};
      cur.lastOutboundSgId = outId || cur.lastOutboundSgId;
      cur.updatedAt = Date.now();
      map[key] = cur;
      saveThreadMap(map);
    }

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

// ---------- Email cleaning (strip sigs/quotes/disclaimers) ----------
function stripQuotedAndSignature(txt) {
  if (!txt) return '';
  let s = String(txt).replace(/\r\n/g, '\n');

  // remove quoted history (lines starting with ">")
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');

  // cut at “On … wrote:”
  const wroteIdx = s.search(/^\s*On .+ wrote:\s*$/im);
  if (wroteIdx !== -1) s = s.slice(0, wroteIdx);

  // cut at header-like block
  const hdrIdx = s.search(/^\s*(From|Sent|To|Subject):\s/im);
  if (hdrIdx !== -1) s = s.slice(0, hdrIdx);

  // separator lines (10+ of -, =, _, en dash, em dash)
  const sepMatch = s.match(/^[\t ]*(?:[-=–—_]){10,}[\t ]*$/m);
  if (sepMatch) s = s.slice(0, sepMatch.index);

  // phone/email/web fields (t./m./e./w.)
  const fieldsMatch = s.match(/^\s*(?:t\.|m\.|e\.|w\.)\s+/im);
  if (fieldsMatch) s = s.slice(0, fieldsMatch.index);

  // legal/disclaimer phrases
  const legalIdx = s.search(
    /(registered address|company\s*(no|number)|confidential(ity)? notice|this message (is|may be) confidential|please consider the environment)/i
  );
  if (legalIdx !== -1) s = s.slice(0, legalIdx);

  // strip stray [img ...]
  s = s.replace(/\[img[\s\S]*?\]/gi, ' ');

  // company-specific nukes (tweak as needed)
  const killPhrases = [
    /stickershop is a trading division/i,
    /theprintshop ltd/i
  ];
  for (const rx of killPhrases) {
    const i = s.search(rx);
    if (i !== -1) { s = s.slice(0, i); break; }
  }

  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 1600) s = s.slice(0, 1590) + '…';
  return s;
}

// ---------- SendGrid Inbound Parse -> WhatsApp (and capture Kayako headers) ----------
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
    const rawHeaders = req.body.headers || '';

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

    // If this email is from Kayako, capture its Message-ID and Case #
    const caseMatch = String(subject || '').match(/\[Case\s*#(\d+)\]/i);
    const caseIdFromSubj = caseMatch ? caseMatch[1] : null;
    const msgId = getHeader(rawHeaders, 'Message-ID'); // often <...@kayako.com>

    const map = loadThreadMap();
    const key = migrateKeyIfNeeded(map, waTo);
    const meta = key ? (map[key] || {}) : {};

    if ((/@kayako\./i.test(fromAddr) || /stickershop\.kayako\.com/i.test(fromAddr)) && msgId) {
      if (/@kayako\./i.test(msgId)) {
        meta.kayakoMsgId = msgId; // store exact value, includes <...>
      }
      if (caseIdFromSubj) {
        meta.caseId = String(caseIdFromSubj);
      }
      meta.updatedAt = Date.now();
      map[key] = meta;
      saveThreadMap(map);
      console.log('🧷 saved Kayako IDs for', key, { caseId: meta.caseId, kayakoMsgId: meta.kayakoMsgId });
    }

    // Build WhatsApp body (clean)
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

    // Relay attachments (skip inline logos)
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

    console.log(
      '➡️  Twilio send\n    FROM:', WA_FROM,
      '\n    TO  :', waTo,
      '\n    BODY:', body.slice(0, 160),
      '\n    media:', mediaUrls.length
    );

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