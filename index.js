// WhatsApp -> Kayako webhook
// - One active case per WhatsApp user
// - Append messages as the REQUESTER (public) using /messages.json

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE = 'https://stickershop.kayako.com';
const API = `${KAYAKO_BASE}/api/v1`;

/* ---------------- helpers ---------------- */

function makeAuthHeaders(csrf, sessionId) {
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

async function getSession() {
  try {
    const r = await axios.get(`${API}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: { 'Content-Type': 'application/json' }
    });
    const csrf = r.headers['x-csrf-token'];
    const sid  = r.data?.session_id;
    console.log('🛡 CSRF Token:', csrf);
    console.log('🍪 Session ID:', sid);
    return (csrf && sid) ? { csrf, sid } : null;
  } catch (e) {
    console.error('❌ Auth error:', e.response?.data || e.message);
    return null;
  }
}

async function findOrCreateUser(email, fullName, ah) {
  try {
    console.log('🔍 Searching for user with email:', email);
    const s = await axios.get(
      `${API}/search.json?query=${encodeURIComponent(email)}&resources=users`,
      ah
    );
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

async function findActiveCaseId(requesterId, ah) {
  try {
    const url =
      `${API}/cases.json?requester_id=${encodeURIComponent(requesterId)}` +
      `&state=ACTIVE&sort=updated_at:desc&limit=1`;
    const r = await axios.get(url, ah);
    const latest = r.data?.data?.[0];
    if (latest) {
      console.log('🔎 Reusing latest ACTIVE case:', latest.id);
      return latest.id;
    }
    return null;
  } catch (e) {
    console.error('❌ findActiveCase error:', e.response?.data || e.message);
    return null;
  }
}

async function createCase(subject, requesterId, message, ah) {
  const payload = {
    subject,
    requester_id: requesterId,
    channel: 'mail',
    contents: [{ type: 'text', body: message }]
  };
  const r = await axios.post(`${API}/cases.json`, payload, ah);
  const id = r.data?.data?.id || r.data?.id;
  console.log('📁 Case created:', id);
  return id;
}

async function appendCustomerMessage(caseId, requesterId, text, ah) {
  // Post to the global messages endpoint as the requester (public)
  const payload = {
    case:     { id: caseId, resource_type: 'case' },
    actor:    { id: requesterId, resource_type: 'user' }, // author = customer
    origin:   'USER',
    is_public:true,
    channel:  'mail',
    contents: [{ type: 'text', body: text }]
  };
  const r = await axios.post(`${API}/messages.json`, payload, ah);
  console.log('✉️ Public reply appended to case:', caseId);
  return r.data;
}

/* ---------------- webhook ---------------- */

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;            // 'whatsapp:+4479...'
  const text = req.body.Body || '';
  console.log(`📩 WhatsApp from ${from}: ${text}`);

  const sess = await getSession();
  if (!sess) return res.status(500).send('Auth failed');
  const ah = makeAuthHeaders(sess.csrf, sess.sid);

  // deterministic email for that WhatsApp number
  const phone = String(from).replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phone}@whatsapp.stickershop.co.uk`;
  const displayName = `WhatsApp: ${phone}`;

  const requesterId = await findOrCreateUser(email, displayName, ah);
  if (!requesterId) return res.status(500).send('User error');
  console.log('✅ Requester ID:', requesterId);

  // one active case per WhatsApp user
  let caseId = await findActiveCaseId(requesterId, ah);
  if (!caseId) {
    caseId = await createCase(displayName, requesterId, text, ah);
    return res.send('<Response></Response>');
  }

  // append as customer
  try {
    await appendCustomerMessage(caseId, requesterId, text, ah);
  } catch (e) {
    console.error('❌ append failed:', e.response?.data || e.message);

    // LAST-RESORT: add a public note so nothing is lost (try text then html)
    try {
      await axios.post(`${API}/cases/${caseId}/notes`, {
        is_public: true,
        contents: [{ type: 'text', body: text }]
      }, ah);
      console.log('🗒️ Fallback: public note added (text)');
    } catch (e2) {
      try {
        await axios.post(`${API}/cases/${caseId}/notes`, {
          is_public: true,
          contents: [{ type: 'html', body: `<p>${String(text).replace(/</g,'&lt;')}</p>` }]
        }, ah);
        console.log('🗒️ Fallback: public note added (html)');
      } catch (e3) {
        console.error('❌ Fallback note failed:', e3.response?.data || e3.message);
        return res.status(500).send('Append failed');
      }
    }
  }

  res.send('<Response></Response>');
});

app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));