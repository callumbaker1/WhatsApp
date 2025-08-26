// index.js
'use strict';

const express = require('express');
const bodyParser = require('body-parser'); // Twilio sends x-www-form-urlencoded
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/v1`;

/* ---------------- Auth + headers ---------------- */
async function getSessionAuth() {
  try {
    const r = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: { username: process.env.KAYAKO_USERNAME, password: process.env.KAYAKO_PASSWORD },
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });
    const csrf = r.headers['x-csrf-token'];
    const sid  = r.data?.session_id;
    console.log('🛡 CSRF Token:', csrf);
    console.log('🍪 Session ID:', sid);
    if (!csrf || !sid) return null;
    return { csrf_token: csrf, session_id: sid };
  } catch (err) {
    console.error('❌ Auth error:', err.response?.data || err.message);
    return null;
  }
}

function authHeaders(csrf_token, session_id) {
  // Add both header AND cookie for CSRF; include Accept + X-Requested-With
  const cookie = [
    `kayako_session_id=${session_id}`,
    `kayako_csrf_token=${csrf_token}`
  ].join('; ');
  return {
    headers: {
      'X-CSRF-Token': csrf_token,
      'Cookie': cookie,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    },
    auth: {
      username: process.env.KAYAKO_USERNAME,
      password: process.env.KAYAKO_PASSWORD
    }
  };
}

/* ---------------- Users ---------------- */
async function findOrCreateUser(email, name, hdrs) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=users`,
      hdrs
    );
    const users = s.data?.data || [];
    if (users.length) {
      const exact = users.find(u => u.resource === 'user' && (u.snippet === email || u.email === email));
      const id = (exact || users[0]).id;
      console.log('✅ Exact user match found:', id);
      return id;
    }
  } catch (err) {
    console.warn('User search failed, will try create:', err.response?.data || err.message);
  }

  try {
    const c = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name || email,
      role_id: 4,
      email
    }, hdrs);
    const newId = c.data?.data?.id || c.data?.id;
    console.log('✅ User created:', newId);
    return newId;
  } catch (err) {
    console.error('❌ User create error:', err.response?.data || err.message);
    return null;
  }
}

/* ---------------- Cases ---------------- */
async function findActiveCaseForRequester(requesterId, email, hdrs) {
  // Preferred: filter /cases by requester + state
  try {
    const r = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      ...hdrs,
      params: { requester_id: requesterId, state: 'ACTIVE', sort: 'updated_at', order: 'desc', limit: 1 }
    });
    const rows = r.data?.data || r.data || [];
    if (rows.length && rows[0].id) {
      console.log('🔎 Reusing latest ACTIVE case via /cases:', rows[0].id);
      return rows[0].id;
    }
  } catch (err) {
    console.warn('↪︎ /cases filter not available:', err.response?.data || err.message);
  }

  // Fallback: search for cases by email
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

/* ---------------- Append helpers ---------------- */
async function tryPost(url, payload, hdrs, label) {
  try {
    const r = await axios.post(url, payload, hdrs);
    console.log(`✅ ${label} OK:`, r.data?.id || r.data);
    return true;
  } catch (err) {
    console.warn(`↪︎ ${label} failed`, err.response?.data || err.message);
    return false;
  }
}
async function tryPatch(url, payload, hdrs, label) {
  try {
    const r = await axios.patch(url, payload, hdrs);
    console.log(`✅ ${label} OK:`, r.data?.id || r.data);
    return true;
  } catch (err) {
    console.warn(`↪︎ ${label} failed`, err.response?.data || err.message);
    return false;
  }
}

/**
 * Try several API shapes your instance might accept.
 * IMPORTANT: no `channel` field; contents use { type:'text', text:'...' }
 */
async function appendToCase(caseId, text, hdrs) {
  const contents = [{ type: 'text', text }];

  // 1) Root posts endpoint (case relationship in payload)
  if (await tryPost(
    `${KAYAKO_API_BASE}/posts.json`,
    { case: { id: caseId }, type: 'message', is_public: true, contents },
    hdrs, 'POST /posts.json'
  )) return true;

  // 2) Case-scoped posts
  if (await tryPost(
    `${KAYAKO_API_BASE}/cases/${caseId}/posts.json`,
    { type: 'message', is_public: true, contents },
    hdrs, 'POST /cases/{id}/posts.json'
  )) return true;

  // 3) PATCH case with contents (some tenants accept this to append a post)
  if (await tryPatch(
    `${KAYAKO_API_BASE}/cases/${caseId}.json`,
    { contents },
    hdrs, 'PATCH /cases/{id}.json'
  )) return true;

  // 4) Notes endpoint (private). First with contents array (strict format)
  if (await tryPost(
    `${KAYAKO_API_BASE}/cases/${caseId}/notes.json`,
    { contents }, // NOTE: contents with {type:'text', text:'...'}
    hdrs, 'POST /cases/{id}/notes.json (contents)'
  )) return true;

  // 5) Notes endpoint variant with { text } only (older builds)
  if (await tryPost(
    `${KAYAKO_API_BASE}/cases/${caseId}/notes.json`,
    { text },
    hdrs, 'POST /cases/{id}/notes.json (text)'
  )) return true;

  return false;
}

/* ---------------- Webhook ---------------- */
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${body}`);

  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');

  const hdrs = authHeaders(session.csrf_token, session.session_id);

  // map WhatsApp number -> synthetic email identity
  const phone = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const name  = from;
  const subject = `WhatsApp: ${phone}`;

  const requester_id = await findOrCreateUser(email, name, hdrs);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');
  console.log('✅ Requester ID:', requester_id);

  try {
    // Reuse/create single active case for this requester
    let caseId = await findActiveCaseForRequester(requester_id, email, hdrs);
    if (!caseId) {
      // Create the case first (no contents here; we’ll append right after)
      const created = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
        subject,
        requester_id
      }, hdrs);
      caseId = created.data?.data?.id || created.data?.id;
      console.log('📁 New case created:', caseId);
    } else {
      console.log('♻️ Appending to existing case:', caseId);
    }

    const ok = await appendToCase(caseId, body, hdrs);
    if (!ok) {
      console.error('❌ All append attempts failed');
      return res.status(500).send('Append failed');
    }

    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('❌ Case flow error:', err.response?.data || err.message);
    res.status(500).send('Case flow error');
  }
});

app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));