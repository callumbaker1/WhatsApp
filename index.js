// index.js
// WhatsApp ➜ Kayako bridge (single threaded case per requester)
//
// ENV required:
//   KAYAKO_USERNAME=youremail@domain
//   KAYAKO_PASSWORD=yourkayakopassword
//   PORT=10000 (Render provides PORT automatically)

'use strict';

const express = require('express');
const bodyParser = require('body-parser'); // parse Twilio x-www-form-urlencoded
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- Kayako config ----------
const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/v1`;

// ---------- Auth: get CSRF + session cookie ----------
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
    const sessionId = resp.data?.session_id;

    console.log('🛡 CSRF Token:', csrf);
    console.log('🍪 Session ID:', sessionId);

    if (!csrf || !sessionId) {
      console.error('❌ Missing CSRF token or session_id from Kayako auth response');
      return null;
    }
    return { csrf_token: csrf, session_id: sessionId };
  } catch (err) {
    console.error('❌ Auth error:', err.response?.data || err.message);
    return null;
  }
}

// Build the standard auth headers for subsequent Kayako calls
function buildAuthHeaders(csrf_token, session_id) {
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

// ---------- Users: find or create by email ----------
async function findOrCreateUser(email, name, authHeaders) {
  try {
    console.log('🔍 Searching for user with email:', email);

    // Search API for users
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=users`,
      authHeaders
    );
    const hits = s.data?.data || [];

    if (hits.length) {
      // Prefer an exact match if present
      const exact = hits.find(u => u.resource === 'user' && (u.snippet === email || u.email === email));
      const userId = (exact || hits[0]).id;
      console.log('✅ Exact user match found:', userId);
      return userId;
    }

    // Create new user
    console.log('👤 User not found, creating…');
    const create = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name || email,
      role_id: 4, // customer
      email
    }, authHeaders);

    const newId = create.data?.data?.id || create.data?.id;
    console.log('✅ User created:', newId);
    return newId;
  } catch (err) {
    console.error('❌ User search/create error:', err.response?.data || err.message);
    return null;
  }
}

// ---------- Cases: find latest ACTIVE by requester (or via search) ----------
async function findActiveCaseForRequester(requesterId, email, authHeaders) {
  // 1) Try filtered /cases.json (some Kayako stacks support this)
  try {
    const r = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      ...authHeaders,
      params: {
        requester_id: requesterId,
        state: 'ACTIVE',
        sort: 'updated_at',
        order: 'desc',
        limit: 1
      }
    });
    const rows = r.data?.data || r.data || [];
    if (rows.length) {
      const id = rows[0].id || rows[0].data?.id;
      if (id) {
        console.log('🔎 Reusing latest ACTIVE case via /cases:', id);
        return id;
      }
    }
  } catch (err) {
    console.warn('↪︎ /cases filter not available; falling back to /search.', err.response?.data || err.message);
  }

  // 2) Fallback: search by email, filter ACTIVE client-side
  try {
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=cases`,
      authHeaders
    );
    const hits = s.data?.data || [];
    const candidates = hits
      .filter(h => (h.state || '').toUpperCase() === 'ACTIVE')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (candidates.length) {
      console.log('🔎 Reusing ACTIVE case via /search:', candidates[0].id);
      return candidates[0].id;
    }
  } catch (err) {
    console.warn('↪︎ /search fallback failed:', err.response?.data || err.message);
  }

  return null;
}

// ---------- Posts/Messages: add a PUBLIC message to a case ----------
async function addPublicMessage(caseId, bodyText, authHeaders, subject = '') {
  // Try multiple endpoints—different Kayako versions enable different routes/fields
  const attempts = [
    {
      url: `${KAYAKO_API_BASE}/messages.json`,
      payload: {
        case_id: caseId,
        status: 'SENT',              // public message
        direction: 'INCOMING',       // from customer
        subject,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    },
    {
      url: `${KAYAKO_API_BASE}/posts.json`,
      payload: {
        case_id: caseId,
        type: 'message',             // message (not note)
        is_public: true,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    },
    {
      url: `${KAYAKO_API_BASE}/cases/${caseId}/messages.json`,
      payload: {
        status: 'SENT',
        direction: 'INCOMING',
        subject,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    }
  ];

  for (const a of attempts) {
    try {
      const resp = await axios.post(a.url, a.payload, authHeaders);
      console.log(`✉️ Public message posted via ${a.url}:`, resp.data?.id || resp.data);
      return true;
    } catch (err) {
      console.warn(`↪︎ Message attempt failed @ ${a.url}`, err.response?.data || err.message);
    }
  }
  return false;
}

// ---------- Webhooks ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const message = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${message}`);

  // 1) Auth for this request cycle
  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');
  const { csrf_token, session_id } = session;
  const authHeaders = buildAuthHeaders(csrf_token, session_id);

  // 2) Normalise phone → whatsapp email identity
  const phone = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const name = from;

  // 3) Ensure user exists
  const requester_id = await findOrCreateUser(email, name, authHeaders);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  const subject = `WhatsApp: ${phone}`;

  try {
    // 4) Reuse or create case
    let caseId = await findActiveCaseForRequester(requester_id, email, authHeaders);

    if (!caseId) {
      // Create a new case WITHOUT contents first
      const create = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
        subject,
        requester_id
        // channel: 'email' // optional; depends on schema
      }, authHeaders);
      caseId = create.data?.data?.id || create.data?.id;
      console.log('📁 New case created:', caseId);
    } else {
      console.log('♻️ Appending to existing case:', caseId);
    }

    // 5) Append WhatsApp text as PUBLIC message so agents can reply
    const ok = await addPublicMessage(caseId, message, authHeaders, subject);
    if (!ok) {
      console.error('❌ Failed to append public message');
      return res.status(500).send('Message creation failed');
    }

    // Twilio only needs a 200 OK; empty TwiML is fine
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('❌ Case error:', err.response?.data || err.message);
    res.status(500).send('Case error');
  }
});

app.get('/', (_req, res) => res.send('Webhook is running ✅'));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));