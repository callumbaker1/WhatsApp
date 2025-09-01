// index.js — WhatsApp ↔ Kayako bridge (route-aware replies + optional template fallback)
// - Twilio inbound  -> SendGrid email to Kayako (supports media)
// - SendGrid inbound -> Twilio WhatsApp (strips signatures, relays attachments)
// - Replies are sent FROM the same WA number the user messaged (fixes 63112 when number mismatch)
// - Optional: template fallback outside 24h window

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
const WA_FROM_DEFAULT = process.env.TWILIO_WHATSAPP_FROM || ''; // fallback if we don't know the per-customer route

// Optional: use a WhatsApp template if outside 24h window
const TEMPLATE_SID  = process.env.WHATSAPP_TEMPLATE_SID || '';   // e.g. HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
const TEMPLATE_VARS = process.env.WHATSAPP_TEMPLATE_VARS || '';  // JSON string, e.g. {"1":"StickerShop"}

const KAYAKO_BASE  = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API   = `${KAYAKO_BASE}/api/v1`;
const KAYAKO_USER  = process.env.KAYAKO_USERNAME || '';
const KAYAKO_PASS  = process.env.KAYAKO_PASSWORD || '';

const FROM_ALLOW   = (process.env.KAYAKO_FROM_ALLOWLIST || 'hello@stickershop.co.uk')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const INBOUND_SECRET = process.env.SG_INBOUND_SECRET || '';
const SERVICE_BASE   = process.env.SERVICE_BASE_URL || ''; // for hosting attachments

// SendGrid
if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Twilio
const tClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// ---------- In-memory state ----------
// Map of customer WA number -> last business WA number they messaged (to reply from same number)
const lastRoute = new Map();   // key: "whatsapp:+4479...", value: "whatsapp:+44BUSINESS"

// Map of (business|customer) -> timestamp of last inbound (for 24h window)
const lastSeen = new Map();    // key: "whatsapp:+BUS|whatsapp:+CUST", value: ms

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
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3', 'text/plain': '.txt'
  };
  return map[(contentType || '').toLowerCase()] || '';
}

async function fetchTwilioMedia(url) {
  const resp = await axios.get(url, {
    auth: { username: TWILIO_SID, password: TWILIO_TOKEN },
    responseType: 'arraybuffer', timeout: 30000
  });
  return Buffer.from(resp.data);
}

function buildSubjectBase(from) {
  return `New message from ${from}`;
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
  try {
    const env = JSON.parse(envelope || '{}');
    const arr = Array.isArray(env.to) ? env.to : (env.to ? [env.to] : []);
    const to = arr.find(a => String(a).toLowerCase().endsWith(`@${FROM_DOMAIN}`)) || arr[0] || '';
    const digits = String((to || '').split('@')[0]).replace(/\D/g, '');
    return digits ? `whatsapp:+${digits}` : null;
  } catch {}
  const addr = firstAddress(toField);
  const digits = String((addr || '').split('@')[0]).replace(/\D/g, '');
  return digits ? `whatsapp:+${digits}` : null;
}

function routeKey(bizTo, userFrom) {
  // key for lastSeen: "whatsapp:+BUS|whatsapp:+CUST"
  return `${bizTo}|${userFrom}`;
}

function isWindowOpen(bizTo, userFrom) {
  const seen = lastSeen.get(routeKey(bizTo, userFrom)) || 0;
  const OPEN_MS = 23 * 60 * 60 * 1000; // conservative 23h
  return Date.now() - seen < OPEN_MS;
}

async function sendWhatsApp({ fromBiz, toUser, body, mediaUrls, statusCallback }) {
  // If we have a template and the window is closed, use template
  if (TEMPLATE_SID && !isWindowOpen(fromBiz, toUser)) {
    let contentVariables = '{}';
    try {
      const base = TEMPLATE_VARS ? JSON.parse(TEMPLATE_VARS) : {};
      if (!base['2'] && body) base['2'] = body.slice(0, 120); // optional summary slot
      contentVariables = JSON.stringify(base);
    } catch {
      console.warn('TEMPLATE_VARS JSON parse failed, using {}');
    }
    console.log('[WA] window closed → sending TEMPLATE', TEMPLATE_SID, 'vars:', contentVariables);
    return tClient.messages.create({
      from: fromBiz,
      to: toUser,
      contentSid: TEMPLATE_SID,
      contentVariables,
      statusCallback
    });
  }

  // Free-form (inside 24h) or no template configured
  const payload = { from: fromBiz, to: toUser, body, statusCallback };
  if (mediaUrls?.length) payload.mediaUrl = mediaUrls;
  console.log('[WA] using free-form');
  return tClient.messages.create(payload);
}

// ---------- WhatsApp -> Kayako (email via SendGrid) ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const fromUser = req.body.From || '';   // "whatsapp:+4479…"
  const toBiz    = req.body.To || '';     // your WA business number that received the msg
  const caption  = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${fromUser} TO ${toBiz}: ${caption || '(no text)'} — media: ${numMedia}`);

  // Remember route and last-seen to support reply + 24h rules
  if (/^whatsapp:\+\d{6,16}$/.test(fromUser) && /^whatsapp:\+\d{6,16}$/.test(toBiz)) {
    lastRoute.set(fromUser, toBiz);
    lastSeen.set(routeKey(toBiz, fromUser), Date.now());
  }

  const fromEmail = buildFromAddress(fromUser);
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
      const safeNum  = fromUser.replace(/\D/g, '');
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
      ? `WhatsApp message from ${fromUser} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  // const subject = existingCaseId
  //   ? `${buildSubjectBase(fromUser)} [Case #${existingCaseId}]`
  //   : buildSubjectBase(fromUser);

  const subject = buildSubjectBase(fromUser);

  const msg = {
    to: SEND_TO,
    from: { email: fromEmail, name: fromUser },
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

// ---------- Temp file hosting for WhatsApp media ----------
const upload = multer({ storage: multer.memoryStorage() });
const FILE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // per file
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

// ---------- Email cleaning ----------
function stripQuotedAndSignature(txt) {
  if (!txt) return '';
  let s = String(txt).replace(/\r\n/g, '\n');
  s = s.split('\n').filter(l => !/^\s*>/.test(l)).join('\n'); // remove quoted lines
  const wroteIdx = s.search(/^\s*On .+ wrote:\s*$/im);
  if (wroteIdx !== -1) s = s.slice(0, wroteIdx);
  const hdrIdx = s.search(/^\s*(From|Sent|To|Subject):\s/im);
  if (hdrIdx !== -1) s = s.slice(0, hdrIdx);
  const sepMatch = s.match(/^[\t ]*(?:[-=–—_]){10,}[\t ]*$/m);
  if (sepMatch) s = s.slice(0, sepMatch.index);
  const fieldsMatch = s.match(/^\s*(?:t\.|m\.|e\.|w\.)\s+/im);
  if (fieldsMatch) s = s.slice(0, fieldsMatch.index);
  const legalIdx = s.search(/(registered address|company\s*(no|number)|confidential(ity)? notice|this message (is|may be) confidential|please consider the environment)/i);
  if (legalIdx !== -1) s = s.slice(0, legalIdx);
  s = s.replace(/\[img[\s\S]*?\]/gi, ' ');
  for (const rx of [/stickershop is a trading division/i, /theprintshop ltd/i]) {
    const i = s.search(rx); if (i !== -1) { s = s.slice(0, i); break; }
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

    const { from, to, envelope, subject } = req.body || {};
    let { text, html } = req.body || {};

    const fromAddr = firstAddress(from);
    if (FROM_ALLOW.length && !FROM_ALLOW.includes(fromAddr)) {
      console.log('⛔️ Ignoring email from non-allowlisted sender:', fromAddr);
      return res.status(200).send('ignored');
    }

    const waTo = toWhatsAppNumber(to, envelope); // customer number
    if (!waTo) {
      console.log('⛔️ Could not derive WhatsApp number from:', to, envelope);
      return res.status(200).send('no-to');
    }

    // Choose the correct business sender number for THIS customer (route-aware)
    const fromBiz = lastRoute.get(waTo) || WA_FROM_DEFAULT;
    if (!/^whatsapp:\+\d{6,16}$/.test(fromBiz)) {
      console.error('❌ No valid WA sender for this customer. fromBiz=', fromBiz);
      return res.status(500).send('bad-from');
    }

    // Build body
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

    // Attachments: skip inline logos; host real attachments temporarily
    const mediaUrls = [];
    const info = (() => { try { return JSON.parse(req.body['attachment-info'] || '{}'); } catch { return {}; } })();
    const inlineNames = new Set(
      Object.values(info)
        .filter(meta => /inline/i.test(meta.disposition || '') || meta['content-id'])
        .map(meta => (meta.filename || '').toLowerCase())
    );

    for (const f of req.files || []) {
      const name = (f.originalname || 'file').toLowerCase();
      if (inlineNames.has(name)) continue;
      if (f.size > 10 * 1024 * 1024) { // 10MB per media safeguard
        console.warn('⚠️ Skipping large attachment:', name, f.size);
        continue;
      }
      const url = storeTempFile(f.buffer, f.mimetype, f.originalname);
      mediaUrls.push(url);
      if (mediaUrls.length >= 10) break; // Twilio limit
    }

    // Decide free-form vs template and send
    const statusCallbackBase =
      SERVICE_BASE || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '';
    const statusCallback = statusCallbackBase ? `${statusCallbackBase}/twilio-status` : undefined;

    console.log('➡️  Twilio send\n    FROM:', fromBiz, '\n    TO  :', waTo, '\n    BODY:', body.slice(0, 160), '\n    media:', mediaUrls.length);
    const msg = await sendWhatsApp({ fromBiz, toUser: waTo, body, mediaUrls, statusCallback });
    console.log('✅ Relayed to WhatsApp SID:', msg.sid, 'Using', (TEMPLATE_SID && !isWindowOpen(fromBiz, waTo)) ? 'template' : 'free-form', 'Subject:', subject || '(no subject)');

    return res.status(200).send('ok');
  } catch (err) {
    console.error('❌ /sg-inbound error:', err.response?.data || err.message || err);
    return res.status(500).send('error');
  }
});

// Optional: Twilio status callback for delivery debugging
app.post('/twilio-status', express.urlencoded({ extended: false }), (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body || {};
  console.log('📬 Twilio status:', 'sid=', MessageSid, 'status=', MessageStatus, 'error=', ErrorCode || 'none');
  res.status(200).send('ok');
});

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));