// index.js – WhatsApp → Kayako bridge (public replies via MAIL channel)
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

// ---------- Session / Auth ----------
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

// ---------- Users ----------
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

// ---------- Channel helpers ----------
async function getMailChannelForNewCase(client, requester_id) {
  try {
    const r = await client.get(`/cases/channels.json`, { params: { user_id: requester_id } });
    const chans = r.data?.data || [];
    const mail = chans.find(c => c.type === 'MAIL');
    if (mail) return { channel: 'MAIL', channel_id: mail.account?.id };
  } catch (e) {
    console.warn('⚠️ Could not retrieve new-case channels:', e.response?.data || e.message);
  }
  return { channel: 'NOTE', channel_id: null }; // safe fallback
}

async function getMailChannelForReply(client, caseId) {
  try {
    const r = await client.get(`/cases/${caseId}/reply/channels.json`);
    const chans = r.data?.data || [];
    const mail = chans.find(c => c.type === 'MAIL');
    if (mail) return { channel: 'MAIL', channel_id: mail.account?.id };
  } catch (e) {
    console.warn('⚠️ Could not retrieve reply channels:', e.response?.data || e.message);
  }
  return { channel: 'NOTE', channel_id: null }; // safe fallback
}

// ---------- Case helpers ----------
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
    if (id) console.log('🔎 Reusing latest ACTIVE case via /cases:', id);
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
    requester_id,
    channel,                 // prefer MAIL so it’s public
    ...(channel_id ? { channel_id } : {}),
    contents: message        // Kayako expects a string here
  };
  const resp = await client.post(`/cases.json`, payload);
  // creation returns a job (202) in docs, but many installs return the case directly (201)
  const caseId = resp.data?.data?.id || resp.data?.id;
  return { id: caseId, raw: resp.data };
}

async function replyToCase(client, caseId, message) {
  const { channel, channel_id } = await getMailChannelForReply(client, caseId);
  const payload = {
    contents: message,       // must be a plain string per docs
    channel,                 // MAIL => public, NOTE => private
    ...(channel_id ? { channel_id } : {})
  };
  return client.post(`/cases/${caseId}/reply.json`, payload);
}

// ---------- Webhook ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;   // e.g. "whatsapp:+44..."
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

  // User
  const requester_id = await findOrCreateUser(client, email, name);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  // Case: reuse or create
  let caseId = await findLatestActiveCaseId(client, requester_id);

  try {
    if (caseId) {
      console.log('♻️ Appending to existing case:', caseId);
      await replyToCase(client, caseId, body);
      console.log('✉️ Public reply appended to case:', caseId);
    } else {
      console.log('🆕 No active case; creating a new one (MAIL)…');
      const created = await createNewMailCase(client, requester_id, from, body);
      console.log('📁 Case created:', created.raw);
      caseId = created.id;
    }

    // Twilio requires a 200 text/xml-ish response even if empty
    res.type('text/xml').send('<Response></Response>');
  } catch (e) {
    console.error('❌ Failed to create/append message:', e.response?.data || e.message);
    res.status(500).send('Kayako error');
  }
});

// Health
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));