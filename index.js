// index.js – WhatsApp → Kayako bridge (post AS REQUESTER + correct case reuse)
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

// ---------------- Session / Auth ----------------
async function getSessionAuth() {
  try {
    const resp = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
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
    timeout: 20000
  });
}

// ---------------- Users ----------------
async function findOrCreateUser(client, email, name) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const sr = await client.get(`/search.json`, {
      params: { query: email, resources: 'users' }
    });

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

// ---------------- Case helpers ----------------

// Find the customer’s most recent open/active case using identity filters.
// Kayako “Retrieve all cases” supports identity_type + identity_value and a status filter.
// (Docs show identity filters; results are ordered by updated_at desc.)  [oai_citation:1‡developer.kayako.com](https://developer.kayako.com/api/v1/cases/cases/)
async function findLatestOpenCaseForIdentity(client, email) {
  try {
    const r = await client.get(`/cases.json`, {
      params: {
        identity_type: 'EMAIL',
        identity_value: email,
        status: 'NEW,OPEN,PENDING', // exclude CLOSED/COMPLETED
        limit: 1
      }
    });
    const caseId = r.data?.data?.[0]?.id || null;
    if (caseId) console.log('🔎 Reusing customer case:', caseId);
    return caseId;
  } catch (e) {
    console.warn('⚠️ Could not list cases for identity:', e.response?.data || e.message);
    return null;
  }
}

// Create a NEW case as the requester, with source=MESSENGER (so it isn’t “from agent”)
async function createNewCaseAsRequester(client, requester_id, from, contents) {
  const payload = {
    subject: `WhatsApp: ${from.replace('whatsapp:', '')}`,
    requester_id,
    channel: 'MAIL',            // public post
    source: 'MESSENGER',        // origin attribution
    contents                   : String(contents || '')
  };

  const resp = await client.post(`/cases.json`, payload);
  const caseId = resp.data?.data?.id || resp.data?.id;
  return { id: caseId, raw: resp.data };
}

// Append a PUBLIC reply AS THE REQUESTER on an existing case.
// Per docs, /cases/{id}/reply.json accepts: contents, channel, requester_id, source.  [oai_citation:2‡developer.kayako.com](https://developer.kayako.com/api/v1/cases/cases/)
async function replyAsRequester(client, caseId, requester_id, contents) {
  const payload = {
    contents    : String(contents || ''),
    channel     : 'MAIL',       // public channel (NOTE would be private)
    requester_id: requester_id, // <- THIS attributes the post to the customer
    source      : 'MESSENGER'   // attribute origin
  };

  return client.post(`/cases/${caseId}/reply.json`, payload);
}

// ---------------- Webhook ----------------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;         // e.g. "whatsapp:+4479..."
  const body = req.body.Body || '';

  console.log(`📩 WhatsApp from ${from}: ${body}`);

  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');
  const client = kayakoClient(session);

  // Build a stable pseudo-email for the WhatsApp identity
  const phone = String(from || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const displayName = from;

  // Ensure a user exists
  const requester_id = await findOrCreateUser(client, email, displayName);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  try {
    // Reuse an open case for THIS identity (not your agent’s)
    let caseId = await findLatestOpenCaseForIdentity(client, email);

    if (caseId) {
      console.log('♻️ Appending to existing case as requester:', caseId);
      await replyAsRequester(client, caseId, requester_id, body);
      console.log('✉️ Public reply (as requester) appended to case:', caseId);
    } else {
      console.log('🆕 No open case for identity; creating a new one as requester…');
      const created = await createNewCaseAsRequester(client, requester_id, from, body);
      console.log('📁 Case created:', created.raw);
      caseId = created.id;
    }

    // Twilio expects 200 OK; an empty TwiML is fine.
    res.type('text/xml').send('<Response/>');
  } catch (e) {
    console.error('❌ Kayako error:', e.response?.data || e.message);
    res.status(500).send('Kayako error');
  }
});

// Health
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));