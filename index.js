const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/v1`;
const KAYAKO_USERNAME = process.env.KAYAKO_USERNAME;
const KAYAKO_PASSWORD = process.env.KAYAKO_PASSWORD;

// 🛡 Get Session ID + CSRF Token
async function getSession() {
  try {
    const response = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: {
        username: KAYAKO_USERNAME,
        password: KAYAKO_PASSWORD
      }
    });

    const cookies = response.headers['set-cookie'] || [];
    const sessionCookie = cookies.find(c => c.includes('kayako_session_id='));

    if (!sessionCookie) {
      console.error('❌ Missing session cookie');
      return null;
    }

    const session_id = sessionCookie
      .split(';')[0]
      .split('=')[1];

    const csrf_token = response.headers['x-csrf-token'];
    return { session_id, csrf_token };
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    return null;
  }
}

// 📬 Incoming WhatsApp Webhook
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const message = req.body.Body;
  const fakeEmail = `${from.replace(/\D/g, '')}@whatsapp.fake`;

  console.log(`📩 WhatsApp from ${from}: ${message}`);

  const session = await getSession();
  if (!session) {
    console.error('❌ Ticket creation failed: Missing session_id or cookie in response');
    return res.status(500).send('Authentication failed');
  }

  const { session_id, csrf_token } = session;

  try {
    await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
      subject: `WhatsApp message from ${from}`,
      channel: "EMAIL",
      requester: fakeEmail,
      contents: [
        {
          type: "text",
          body: message
        }
      ]
    }, {
      headers: {
        'X-CSRF-Token': csrf_token,
        'Cookie': `kayako_session_id=${session_id}`,
        'Content-Type': 'application/json'
      },
      auth: {
        username: KAYAKO_USERNAME,
        password: KAYAKO_PASSWORD
      }
    });

    console.log('✅ Ticket successfully created');
    res.send('<Response></Response>');
  } catch (error) {
    const data = error.response?.data || error.message;
    console.error('❌ Ticket creation failed:', data);
    res.status(500).send('Ticket creation failed');
  }
});

// 🧪 Test endpoint
app.get('/', (req, res) => res.send("✅ WhatsApp webhook is running"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));