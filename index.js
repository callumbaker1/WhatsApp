const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config(); // only works locally; for Render, use environment variables panel

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com';
const KAYAKO_API_VERSION = 'v1';
const KAYAKO_API_BASE = `${KAYAKO_BASE_URL}/api/${KAYAKO_API_VERSION}`;

// 🔐 Session-based authentication (basic login to get session + CSRF token)
async function getSessionAuth() {
  const authString = Buffer.from(`${process.env.KAYAKO_USERNAME}:${process.env.KAYAKO_PASSWORD}`).toString('base64');

  const sessionResponse = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
    headers: {
      Authorization: `Basic ${authString}`,
      'Content-Type': 'application/json'
    }
  });

  // Debug logs:
  console.log('🔍 Headers:', sessionResponse.headers);
  console.log('🔍 Data:', sessionResponse.data);

  const cookies = sessionResponse.headers['set-cookie'];
  const session_id = cookies?.find(c => c.includes('session_id'))?.split(';')[0]?.split('=')[1];

  if (!cookies || !session_id) {
    console.error("❌ Missing set-cookie headers or session_id");
    throw new Error('Missing session_id or cookie in response');
  }

  const csrf_token = sessionResponse.headers['x-csrf-token'];
  if (!csrf_token) {
    console.error("❌ Missing CSRF token in headers");
    throw new Error('Missing CSRF token');
  }

  return { session_id, csrf_token };
}

// ✅ Incoming WhatsApp webhook
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`📩 WhatsApp from ${from}: ${body}`);

  try {
    const { session_id, csrf_token } = await getSessionAuth();

    // Create ticket
    const response = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
      subject: `WhatsApp from ${from}`,
      channel_id: 1, // You may need to set a valid channel_id
      contents: [{
        body: body,
        content_type: "plaintext"
      }],
      requester_id: 1 // You'll likely need to map/create users and provide a valid ID
    }, {
      headers: {
        Cookie: `session_id=${session_id}`,
        'X-CSRF-Token': csrf_token,
        'Content-Type': 'application/json'
      }
    });

    console.log("✅ Ticket successfully created:", response.data);
    res.send('<Response></Response>');
  } catch (error) {
    console.error("❌ Ticket creation failed:", error.response?.data || error.message);
    res.status(500).send("Ticket creation failed");
  }
});

app.get('/', (req, res) => res.send("Webhook is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));