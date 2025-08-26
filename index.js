// WhatsApp -> Kayako webhook
// - One active case per WhatsApp user
// - Append messages as the REQUESTER (not agent)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const API = `${KAYAKO_BASE_URL}/api/v1`;

// ---------- helpers ----------
function authHeaders(csrf, sessionId) {
  return {
    headers: {
      'X-CSRF-Token': csrf,
      'Cookie': `kayako_session_id=${sessionId}`,
      'Content-Type': 'application/json'
    },
    auth: {
      username: process.env.KAYAKO_USERNAME,
      password: process.env.KAYAKO_PASSWORD
    }
  };
}

async function getSessionAuth() {
  try {
    // any authed GET gives us CSRF + session
    const r = await axios.get(`${API}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: { 'Content-Type': 'application/json' }
    });
    const csrf = r.headers['x-csrf-token'];
    const sessionId = r.data?.session_id;
    console.log('🛡 CSRF Token:', csrf);
    console.log('🍪 Session ID:', sessionId);
    if (!csrf || !sessionId) return null;
    return { csrf, sessionId };
  } catch (e) {
    console.error('❌ Auth error:', e.response?.data || e.message);
    return null;
  }
}

async function findOrCreateUser(email, fullName, ah) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const s = await axios.get(`${API}/search.json?query=${encodeURIComponent(email)}&resources=users`, ah);
    const hits = s.data?.data || [];
    if (hits.length) {
      const exact = hits.find(u => u.resource === 'user' && u.snippet === email);
      const id = exact ? exact.id : hits[0].id;
      console.log('✅ Exact user match found:', id);
      return id;
    }
    console.log('👤 User not found, creating...');
    const c = await axios.post(`${API}/users.json`, {
      full_name: fullName,
      role_id: 4, // customer
      email
    }, ah);
    const id = c.data?.data?.id || c.data?.id;
    console.log('✅ User created:', id);
    return id;
  } catch (e) {
    console.error('❌ User error:', e.response?.data || e.message);
    return null;
  }
}

// Get the user's email identity id (needed so the message is “from” them)
async function getEmailIdentityId(userId, email, ah) {
  try {
    const r = await axios.get(`${API}/users/${userId}/identities.json`, ah);
    const identities = r.data?.data || [];
    const emailId = identities.find(i =>
      (i.resource_type === 'identity_email' || i.type === 'email') &&
      (i.email?.toLowerCase?.() === email.toLowerCase())
    )?.id;

    if (emailId) {
      return emailId;
    }

    // Fallback: create an email identity for this address
    const c = await axios.post(`${API}/users/${userId}/identities.json`, {
      type: 'email',
      email
    }, ah);
    return c.data?.data?.id || c.data?.id;
  } catch (e) {
    console.error('❌ identity error:', e.response?.data || e.message);
    return null;
  }
}

// Find the most recent ACTIVE/OPEN case for requester
async function findActiveCaseId(requesterId, ah) {
  try {
    // Filter by requester + ACTIVE state, newest first, limit 1
    const url = `${API}/cases.json?requester_id=${encodeURIComponent(requesterId)}&state=ACTIVE&sort=updated_at:desc&limit=1`;
    const r = await axios.get(url, ah);
    const latest = r.data?.data?.[0];
    if (latest) {
      console.log('🔎 Reusing latest ACTIVE case via /cases:', latest.id);
      return latest.id;
    }
    return null;
  } catch (e) {
    console.error('❌ findActiveCase error:', e.response?.data || e.message);
    return null;
  }
}

async function createNewCase(subject, requesterId, message, ah) {
  const payload = {
    subject,
    requester_id: requesterId,
    channel: 'mail',               // valid channel key
    contents: [{ type: 'text', body: message }]
  };
  const r = await axios.post(`${API}/cases.json`, payload, ah);
  console.log('📁 Case created:', r.data?.data?.id || r.data?.id);
  return r.data?.data?.id || r.data?.id;
}

// Append a PUBLIC message as the REQUESTER (not the agent)
async function appendMessageAsRequester(caseId, requesterId, identityId, text, ah) {
  const payload = {
    case:      { id: caseId, resource_type: 'case' },
    actor:     { id: requesterId, resource_type: 'user' },     // who is speaking
    identity:  { id: identityId,  resource_type: 'identity_email' }, // “via” which email
    channel:   'mail',                                        // show as email-style message
    origin:    'USER',                                        // from the requester
    is_public: true,
    contents:  [{ type: 'text', body: text }]
  };

  // POST to messages
  const r = await axios.post(`${API}/messages.json`, payload, ah);
  console.log('✉️ Public reply appended to case:', caseId);
  return r.data;
}

// ---------- webhook ----------
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;         // e.g. 'whatsapp:+4479...'
  const body = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${body}`);

  const auth = await getSessionAuth();
  if (!auth) return res.status(500).send('Auth failed');

  const { csrf, sessionId } = auth;
  const ah = authHeaders(csrf, sessionId);

  // Create a unique email for this WhatsApp number
  const phone = String(from).replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const displayName = `WhatsApp: ${phone}`;

  // Ensure requester exists
  const requesterId = await findOrCreateUser(email, displayName, ah);
  if (!requesterId) return res.status(500).send('User error');
  console.log('✅ Requester ID:', requesterId);

  // Ensure we have an email identity for this address
  const identityId = await getEmailIdentityId(requesterId, email, ah);

  // Find (or create) an active case for this requester
  let caseId = await findActiveCaseId(requesterId, ah);
  if (!caseId) {
    caseId = await createNewCase(displayName, requesterId, body, ah);
    return res.send('<Response></Response>'); // first message became the case’s first message
  }

  console.log('♻️ Appending to existing case:', caseId);

  // Try to append as REQUESTER
  try {
    await appendMessageAsRequester(caseId, requesterId, identityId, body, ah);
  } catch (e) {
    console.error('❌ append as requester failed:', e.response?.data || e.message);
    // Last-resort fallback: add a public note so nothing is lost
    try {
      await axios.post(`${API}/cases/${caseId}/notes.json`, {
        is_public: true,
        contents: [{ type: 'text', body }]
      }, ah);
      console.log('🗒️ Fallback: public note added');
    } catch (e2) {
      console.error('❌ Fallback note failed:', e2.response?.data || e2.message);
      return res.status(500).send('Append failed');
    }
  }

  res.send('<Response></Response>');
});

// health
app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));