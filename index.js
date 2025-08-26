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

/* ---------------- Session / CSRF ---------------- */
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
    const session_id  = resp.data?.session_id;

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

/* ---------------- Users ---------------- */
async function findOrCreateUser(email, name, authHeaders) {
  try {
    console.log('🔍 Searching for user with email:', email);

    const searchUrl = `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=users`;
    const searchResp = await axios.get(searchUrl, authHeaders);
    const users = searchResp.data?.data || [];

    if (users.length) {
      const exact = users.find(u => u.resource === 'user' && u.snippet === email);
      const id = (exact || users[0]).id;
      console.log('✅ Exact user match found:', id);
      return id;
    }

    console.log('👤 User not found, creating new one…');
    const createResp = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name,
      role_id: 4,
      email
    }, authHeaders);

    const newId = createResp.data?.data?.id || createResp.data?.id;
    console.log('✅ User created:', newId);
    return newId;
  } catch (err) {
    console.error('❌ User search/create error:', err.response?.data || err.message);
    return null;
  }
}

/* ---------------- Channels (for MAIL) ---------------- */
// If you want to create the first post as MAIL (public), you need a channel_id.
async function getMailChannelId(authHeaders) {
  try {
    const r = await axios.get(`${KAYAKO_API_BASE}/cases/channels/new.json`, authHeaders);
    // Find any Mail channel (or use process.env.KAYAKO_MAIL_CHANNEL_ID to hardcode)
    const mailChan = (r.data?.data || []).find(c => (c.type || c.resource || '').toUpperCase() === 'MAIL') 
                  || (r.data?.data || []).find(c => (c.title || '').toUpperCase() === 'MAIL');
    return mailChan?.id || null;
  } catch (err) {
    console.error('⚠️ Could not fetch Mail channel list:', err.response?.data || err.message);
    return null;
  }
}

/* ---------------- Webhook ---------------- */
app.post('/incoming-whatsapp', async (req, res) => {
  const from    = req.body.From;           // e.g. 'whatsapp:+447...'
  const message = req.body.Body || '';     // the text
  console.log(`📩 WhatsApp from ${from}: ${message}`);

  const session = await getSessionAuth();
  if (!session) return res.status(500).send('Auth failed');

  const { csrf_token, session_id } = session;

  const phoneNumber = String(from || '').replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phoneNumber}@whatsapp.stickershop.co.uk`;
  const name  = from;

  const authHeaders = {
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

  const requester_id = await findOrCreateUser(email, name, authHeaders);
  if (!requester_id) return res.status(500).send('User lookup/creation failed');

  console.log('✅ Requester ID:', requester_id);

  try {
    // Choose how you want the initial case post created:
    // - 'NOTE' (internal note, simplest, no channel_id needed)
    // - 'MAIL' (public post; requires channel_id)
    const createChannel = (process.env.KAYAKO_CREATE_CHANNEL || 'NOTE').toUpperCase();

    const casePayload = {
      subject: `WhatsApp: ${phoneNumber}`,
      requester_id,
      channel: createChannel,
      contents: message        // MUST be a plain string
    };

    if (createChannel === 'MAIL') {
      const channel_id = process.env.KAYAKO_MAIL_CHANNEL_ID
        ? parseInt(process.env.KAYAKO_MAIL_CHANNEL_ID, 10)
        : await getMailChannelId(authHeaders);

      if (!channel_id) {
        console.warn('⚠️ MAIL channel_id not available, falling back to NOTE');
        casePayload.channel = 'NOTE';
      } else {
        casePayload.channel_id = channel_id;
      }
    }

    const resp = await axios.post(`${KAYAKO_API_BASE}/cases.json`, casePayload, authHeaders);
    console.log('📁 Case created:', resp.data);

    // Twilio needs a 200 quickly
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('❌ Ticket creation failed:', err.response?.data || err.message);
    res.status(500).send('Ticket creation failed');
  }
});

app.get('/', (_req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));