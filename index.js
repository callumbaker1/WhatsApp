// index.js — WhatsApp ⇄ Kayako
// Inbound: WhatsApp → SendGrid email → Kayako (existing flow)
// Outbound: Kayako (agent public reply via webhook) → Twilio WhatsApp

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
const SEND_TO      = process.env.MAIL_TO;                          // e.g. hello@stickershop.co.uk
const FROM_DOMAIN  = process.env.MAIL_FROM_DOMAIN || 'whatsapp.stickershop.co.uk';
const TW_SID       = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM      = process.env.TWILIO_WHATSAPP_FROM;             // e.g. 'whatsapp:+447911123456'

const KAYAKO_BASE  = (process.env.KAYAKO_BASE_URL || 'https://stickershop.kayako.com').replace(/\/+$/, '');
const KAYAKO_API   = `${KAYAKO_BASE}/api/v1`;
const KY_USER      = process.env.KAYAKO_USERNAME;
const KY_PASS      = process.env.KAYAKO_PASSWORD;
const KY_SECRET    = process.env.KAYAKO_WEBHOOK_SECRET || '';

if (!process.env.SENDGRID_API_KEY) console.error('❌ Missing SENDGRID_API_KEY');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---------- Shared helpers ----------
function kayakoClient() {
  return axios.create({
    baseURL: KAYAKO_API,
    auth: { username: KY_USER, password: KY_PASS },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

function buildFromAddress(phone) {
  // "whatsapp:+4479…" → "4479…@whatsapp.stickershop.co.uk"
  const num = String(phone || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  return `${num}@${FROM_DOMAIN}`;
}

function emailToWhatsappAddress(email) {
  // "4479…@whatsapp.stickershop.co.uk" → "whatsapp:+4479…"
  const [local, domain] = String(email || '').trim().toLowerCase().split('@');
  if (!local || domain !== FROM_DOMAIN.toLowerCase()) return null;
  const digits = local.replace(/\D/g, '');
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
  return map[contentType.toLowerCase()] || '';
}

async function fetchTwilioMedia(url) {
  // Twilio media URLs require basic auth with SID/TOKEN
  const resp = await axios.get(url, {
    auth: { username: TW_SID, password: TW_TOKEN },
    responseType: 'arraybuffer',
    timeout: 30000
  });
  return Buffer.from(resp.data);
}

function buildSubject(from, caseId) {
  const base = `WhatsApp message from ${from}`;
  return caseId ? `${base} [Case #${caseId}]` : base;
}

// ---------- Twilio send ----------
async function sendWhatsApp(toWa, body, mediaUrls = []) {
  if (!TW_SID || !TW_TOKEN || !TW_FROM) {
    throw new Error('Missing Twilio env (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM)');
  }

  const form = new URLSearchParams();
  form.append('From', TW_FROM);
  form.append('To', toWa);
  if (body) form.append('Body', body);
  (mediaUrls || []).slice(0, 10).forEach(u => form.append('MediaUrl', u));

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TW_SID}/Messages.json`;
  const resp = await axios.post(url, form.toString(), {
    auth: { username: TW_SID, password: TW_TOKEN },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return resp.data;
}

// ---------- Kayako helpers for outbound ----------
async function getRequesterWhatsappFromCase(caseId) {
  const ky = kayakoClient();

  // 1) Get case to find requester user id
  const c = await ky.get(`/cases/${caseId}.json`);
  const requesterId =
    c.data?.data?.requester?.id ||
    c.data?.requester?.id ||
    null;
  if (!requesterId) return null;

  // 2) List requester identities; find our pseudo email on FROM_DOMAIN
  const ids = await ky.get(`/users/${requesterId}/identities.json`).catch(() => ({ data: { data: [] } }));
  const list = ids.data?.data || [];
  const emailIdentity = list.find(i => {
    const addr = (i.email || i.address || i.value || '').toLowerCase();
    return addr.endsWith(`@${FROM_DOMAIN.toLowerCase()}`);
  });
  if (!emailIdentity) return null;

  const email = emailIdentity.email || emailIdentity.address || emailIdentity.value;
  return emailToWhatsappAddress(email);
}

// ===================================================
// =============== INBOUND: WhatsApp =================
// ===================================================
app.post('/incoming-whatsapp', async (req, res) => {
  const from     = req.body.From || '';              // "whatsapp:+4479…"
  const caption  = (req.body.Body || '').trim();     // may be empty if only media
  const numMedia = parseInt(req.body.NumMedia || '0', 10) || 0;

  console.log(`📩 WhatsApp from ${from}: ${caption || '(no text)'} — media: ${numMedia}`);

  // Build "From" email used to create/identify the requester
  const fromEmail = buildFromAddress(from);

  // Optional: try to find an existing open case to include in subject
  let existingCaseId = null;
  try {
    const ky = kayakoClient();
    const r = await ky.get('/cases.json', {
      params: {
        identity_type: 'EMAIL',
        identity_value: fromEmail,
        status: 'NEW,OPEN,PENDING',
        limit: 1,
        sort: 'updated_at',
        order: 'desc'
      }
    });
    existingCaseId = r.data?.data?.[0]?.id || null;
    if (existingCaseId) console.log('🔎 Found open case for identity:', existingCaseId);
  } catch (e) {
    console.warn('⚠️ Case lookup failed:', e.response?.data || e.message);
  }

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

  // Ensure SendGrid has at least one char of text
  const bodyText =
    caption ||
    (attachments.length
      ? `WhatsApp message from ${from} with ${attachments.length} attachment(s).`
      : 'WhatsApp message (no text).');

  const msg = {
    to: SEND_TO,                                   // Kayako mailbox
    from: { email: fromEmail, name: from },        // pseudo-identity (customer)
    subject: buildSubject(from, existingCaseId),   // add [Case #123456] if found
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

// ===================================================
// ============== OUTBOUND: Kayako → WA ==============
// ===================================================
// Kayako Business Rule should POST JSON like:
// { "case_id": "{{case.id}}", "contents": "{{post.plain_body}}" }
app.post('/kayako-outbound', async (req, res) => {
  try {
    // Basic shared-secret check
    const provided = req.headers['x-webhook-secret'] || req.headers['x-kayako-signature'] || req.body.secret;
    if (KY_SECRET && String(provided) !== String(KY_SECRET)) {
      console.warn('🔐 Webhook secret mismatch');
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const caseId   = req.body.case_id || req.body.case?.id || req.body.id;
    const contents = (req.body.contents || req.body.message || req.body.body || '').toString().trim();

    if (!caseId || !contents) {
      return res.status(400).json({ ok: false, error: 'bad_payload' });
    }

    // Who to send to? Look up the requester’s whatsapp pseudo identity
    const toWa = await getRequesterWhatsappFromCase(caseId);
    if (!toWa) {
      console.warn(`⚠️ No WhatsApp identity found for case ${caseId}`);
      return res.status(404).json({ ok: false, error: 'no_whatsapp_identity' });
    }

    await sendWhatsApp(toWa, contents);
    console.log(`➡️  Sent WhatsApp to ${toWa} from case #${caseId}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('❌ Outbound error:', err.response?.data || err.message || err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));