// index.js – WhatsApp → Kayako bridge (customer-authored replies via MESSENGER when available)
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/v1`;

/* ---------------- Session / Auth ---------------- */
async function getSessionAuth() {
  try {
    const resp = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: { 'Content-Type': 'application/json' }
    });

    const csrf = resp.headers['x-csrf-token'];
    const session_id = resp.data?.session_id;
    console.log('🛡 CSRF Token:', csrf);
    console.log('🍪 Session ID:', session_id);

    if (!csrf || !session_id) return null;
    return { csrf, session_id };
  } catch (e) {
    console.error('❌ Auth error:', e.response?.data || e.message);
    return null;
  }
}

function kayakoClient({ csrf, session_id }) {
  return axios.create({
    baseURL: KAYAKO_API_BASE,
    auth: {
      username: process.env.KAYAKO_USERNAME,
      password: process.env.KAYAKO_PASSWORD
    },
    headers: {
      'X-CSRF-Token': csrf,
      'Cookie': `kayako_session_id=${session_id}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
}

/* ---------------- Users ---------------- */
async function findOrCreateUser(client, email, name) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const sr = await client.get(`/search.json`, { params: { query: email, resources: 'users' } });
    const hits = sr.data?.data || [];
    const matched = hits.find(u => u.resource === 'user' && (u.snippet === email || u.email === email));
    if (matched) {
      console.log('✅ Exact user match found:', matched.id);
      return matched.id;
    }

    console.log('👤 User not found, creating…');
    const cr = await client.post(`/users.json`, {
      full_name: name,
      role_id: 4,
      email
    });
    const uid = cr.data?.data?.id || cr.data?.id;
    console.log('✅ User created:', uid);
    return uid;
  } catch (e) {
    console.error('❌ User lookup/create failed:', e.response?.data || e.message);
    return null;
  }
}

/* ---------------- Channel helpers ---------------- */

// For a NEW case: we’ll create via MAIL (public & reply-able)
// We still look up the correct mailbox account id for the requester.
async function getMailChannelForNewCase(client, requester_id) {
  try {
    const r = await client.get(`/cases/channels.json`, { params: { user_id: requester_id } });
    const chans = r.data?.data || [];
    const mail = chans.find(c => c.type === 'MAIL');
    if (mail) return { channel: 'MAIL', channel_id: mail.account?.id };
  } catch (e) {
    console.warn('⚠️ Could not retrieve new-case channels:', e.response?.data || e.message);
  }
  return { channel: 'MAIL', channel_id: null }; // still create, even if id unknown
}

// For REPLIES: prefer MESSENGER if Kayako allows; otherwise MAIL.
// We also return which type was picked so we can annotate the payload.
async function getPreferredReplyChannel(client, caseId) {
  try {
    const r = await client.get(`/cases/${caseId}/reply/channels.json`);
    const chans = r.data?.data || [];
    const messenger = chans.find(c => c.type === 'MESSENGER');
    if (messenger) return { type: 'MESSENGER', channel_id: messenger.account?.id };

    const mail = chans.find(c => c.type === 'MAIL');
    if (mail) return { type: 'MAIL', channel_id: mail.account?.id };
  } catch (e) {
    console.warn('⚠️ Could not retrieve reply channels:', e.response?.data || e.message);
  }
  // Fallback to MAIL semantics if the API won’t list channels
  return { type: 'MAIL', channel_id: null };
}

/* ---------------- Case helpers ---------------- */
async function findLatestActiveCaseId(client, requester_id) {
  try {
    const r = await client.get(`/cases.json`, {
      params: {
        requester_id,
        state: 'ACTIVE',
        sort: 'created_at',
        order: 'desc',
        limit: 1
      }
    });
    const id = r.data?.data?.[0]?.id;
    if (id) console.log('🔎 Reusing latest ACTIVE case:', id);
    return id || null;
  } catch (e) {
    console.warn('⚠️ Could not list cases:', e.response?.data || e.message);
    return null;
  }
}

async function createNewMailCase(client, requester_id, from, message) {
  const { channel, channel_id } = await getMailChannelForNewCase(client, requester_id);
  const payload = {
    subject: `WhatsApp: ${from.replace('whatsapp:', '')}`,
    requester_id,                 // attribute to the customer
    channel,                      // MAIL (public)
    ...(channel_id ? { channel_id } : {}),
    contents: message             // plain string
  };
  const resp = await client.post(`/cases.json`, payload);
  const caseId = resp.data?.data?.id || resp.data?.id;
  return { id: caseId, raw: resp.data };
}

// Reply as the customer (requester). Prefer MESSENGER; fallback to MAIL.
// IMPORTANT: include requester_id so the post is authored by the customer.
async function replyToCaseAsRequester(client, caseId, requester_id, message) {
  const ch = await getPreferredReplyChannel(client, caseId);
  console.log(`↪︎ Using reply channel: ${ch.type}${ch.channel_id ? ` (id ${ch.channel_id})` : ''}`);

  const payload = {
    contents: message,
    requester_id,                // <- this attributes the post to the customer
    channel: ch.type,            // 'MESSENGER' or 'MAIL'
    ...(ch.channel_id ? { channel_id: ch.channel_id } : {}),
    // Nice-to-have: tag the origin (purely informational)
    source: ch.type === 'MESSENGER' ? 'MESSENGER' : 'API'
  };

  // Only the documented reply endpoint; earlier endpoints produced APP_NOT_FOUND/405
  return client.post(`/cases/${caseId}/reply.json`, payload);
}

/* ---------------- Webhook ---------------- */
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;   // e.g. "whatsapp:+4479…"
  const body = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${body}`);

  // Session + client
  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');
  const client = kayakoClient(session);

  // WhatsApp identity → pseudo email + display name
  const phone = String(from || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const name  = from;

  // Ensure a Kayako user exists
  const requester_id = await findOrCreateUser(client, email, name);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  // Reuse latest ACTIVE case or create one
  let caseId = await findLatestActiveCaseId(client, requester_id);

  try {
    if (caseId) {
      console.log('♻️ Appending to existing case:', caseId);
      await replyToCaseAsRequester(client, caseId, requester_id, body);
      console.log('✉️ Customer-authored reply appended to case:', caseId);
    } else {
      console.log('🆕 No active case; creating a new public case (MAIL)…');
      const created = await createNewMailCase(client, requester_id, from, body);
      console.log('📁 Case created:', created.raw);
      caseId = created.id;
    }

    // Twilio expects a 200 text/xml-style response
    res.type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error('❌ Failed to create/append message:', e.response?.data || e.message);
    res.status(500).send('Kayako error');
  }
});

/* ---------------- Health ---------------- */
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));