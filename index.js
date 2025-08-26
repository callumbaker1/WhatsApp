// index.js
// WhatsApp ➜ Kayako bridge (single-thread case per requester, public messages)
//
// ENV:
//   KAYAKO_USERNAME=youremail@domain
//   KAYAKO_PASSWORD=yourpassword
//   PORT=10000  (Render will inject PORT)

'use strict';

const express = require('express');
const bodyParser = require('body-parser'); // Twilio sends x-www-form-urlencoded
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Kayako config ----------
const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/v1`;

// ---------- Auth helpers ----------
async function getSessionAuth() {
  try {
    const resp = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: { 'Content-Type': 'application/json' }
    });

    const csrf_token = resp.headers['x-csrf-token'];
    const session_id = resp.data?.session_id;

    console.log('🛡 CSRF Token:', csrf_token);
    console.log('🍪 Session ID:', session_id);

    if (!csrf_token || !session_id) {
      console.error('❌ Missing CSRF token or session_id');
      return null;
    }
    return { csrf_token, session_id };
  } catch (err) {
    console.error('❌ Auth error:', err.response?.data || err.message);
    return null;
  }
}

function authHeaders(csrf_token, session_id) {
  return {
    headers: {
      'X-CSRF-Token': csrf_token,
      'Cookie': `kayako_session_id=${session_id}`,
      'Content-Type': 'application/json'
    },
    auth: {
      username: process.env.KAYAKO_USERNAME,
      password: process.env.KAYAKO_PASSWORD
    }
  };
}

// ---------- Users ----------
async function findOrCreateUser(email, name, hdrs) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=users`,
      hdrs
    );
    const hits = s.data?.data || [];
    if (hits.length) {
      const exact = hits.find(u => u.resource === 'user' && (u.snippet === email || u.email === email));
      const id = (exact || hits[0]).id;
      console.log('✅ Exact user match found:', id);
      return id;
    }

    console.log('👤 User not found, creating…');
    const create = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name || email, role_id: 4, email
    }, hdrs);

    const newId = create.data?.data?.id || create.data?.id;
    console.log('✅ User created:', newId);
    return newId;
  } catch (err) {
    console.error('❌ User search/create error:', err.response?.data || err.message);
    return null;
  }
}

// ---------- Cases ----------
async function findActiveCaseForRequester(requesterId, email, hdrs) {
  // Try filtered /cases first
  try {
    const r = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      ...hdrs,
      params: {
        requester_id: requesterId,
        state: 'ACTIVE',
        sort: 'updated_at',
        order: 'desc',
        limit: 1
      }
    });
    const rows = r.data?.data || r.data || [];
    if (rows.length && rows[0].id) {
      console.log('🔎 Reusing latest ACTIVE case via /cases:', rows[0].id);
      return rows[0].id;
    }
  } catch (err) {
    console.warn('↪︎ /cases filter not available; falling back to /search.', err.response?.data || err.message);
  }

  // Fallback: search by email, filter ACTIVE
  try {
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=cases`,
      hdrs
    );
    const hits = s.data?.data || [];
    const active = hits
      .filter(h => (h.state || '').toUpperCase() === 'ACTIVE')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (active.length) {
      console.log('🔎 Reusing ACTIVE case via /search:', active[0].id);
      return active[0].id;
    }
  } catch (err) {
    console.warn('↪︎ /search fallback failed:', err.response?.data || err.message);
  }

  return null;
}

// ---------- Append a PUBLIC message (preferred) or fall back ----------
async function addPublicMessage(caseId, body, hdrs, subject = '') {
  // 1) Preferred: case-scoped posts endpoint (message)
  try {
    const url = `${KAYAKO_API_BASE}/cases/${caseId}/posts.json`;
    const payload = {
      type: 'message',                 // public message
      is_public: true,                 // some stacks need this
      channel: 'email',                // any valid built-in channel
      contents: [{ type: 'text', body }]
    };
    const r = await axios.post(url, payload, hdrs);
    console.log('✉️ Public message via /cases/{id}/posts:', r.data?.id || r.data);
    return true;
  } catch (err) {
    console.warn('↪︎ /cases/{id}/posts failed', err.response?.data || err.message);
  }

  // 2) Fallback: PATCH the case with contents (many stacks append as a post)
  try {
    const url = `${KAYAKO_API_BASE}/cases/${caseId}.json`;
    const payload = {
      contents: [
        { type: 'text', body, channel: 'email' } // will append a post (public/note depends on stack)
      ]
    };
    const r = await axios.patch(url, payload, hdrs);
    console.log('✉️ Message appended via PATCH /cases/{id}:', r.data?.id || r.data);
    return true;
  } catch (err) {
    console.warn('↪︎ PATCH /cases/{id} failed', err.response?.data || err.message);
  }

  // 3) Last resort: create a note so the content is still captured
  try {
    const url = `${KAYAKO_API_BASE}/cases/${caseId}/notes.json`;
    const payload = { contents: [{ type: 'text', body }] };
    const r = await axios.post(url, payload, hdrs);
    console.log('🗒️ Fallback note created via /cases/{id}/notes:', r.data?.id || r.data);
    return true;
  } catch (err) {
    console.warn('↪︎ /cases/{id}/notes failed', err.response?.data || err.message);
  }

  return false;
}

// ---------- Webhook ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const message = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${message}`);

  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');

  const { csrf_token, session_id } = session;
  const hdrs = authHeaders(csrf_token, session_id);

  // map WhatsApp number -> synthetic email identity
  const phone = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const name = from;
  const subject = `WhatsApp: ${phone}`;

  // Ensure requester
  const requester_id = await findOrCreateUser(email, name, hdrs);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  try {
    // Reuse or create case
    let caseId = await findActiveCaseForRequester(requester_id, email, hdrs);

    if (!caseId) {
      const create = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
        subject,
        requester_id
      }, hdrs);
      caseId = create.data?.data?.id || create.data?.id;
      console.log('📁 New case created:', caseId);
    } else {
      console.log('♻️ Appending to existing case:', caseId);
    }

    // Append as public message (with graceful fallbacks)
    const ok = await addPublicMessage(caseId, message, hdrs, subject);
    if (!ok) {
      console.error('❌ Failed to append public message');
      return res.status(500).send('Message creation failed');
    }

    // Respond to Twilio
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('❌ Case flow error:', err.response?.data || err.message);
    res.status(500).send('Case flow error');
  }
});

app.get('/', (_req, res) => res.send('Webhook is running ✅'));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));