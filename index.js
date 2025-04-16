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

async function getSessionAuth() {
  try {
    const response = await axios.get(`${KAYAKO_API_BASE}/cases.json`, {
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      },
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const csrf_token = response.headers['x-csrf-token'];
    const session_id = response.data.session_id;

    if (!csrf_token || !session_id) {
      console.error('❌ Missing CSRF token or session_id');
      return null;
    }

    return {
      csrf_token,
      session_id
    };
  } catch (error) {
    console.error("❌ Auth error:", error.message);
    return null;
  }
}

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const message = req.body.Body;

  console.log(`📩 WhatsApp from ${from}: ${message}`);

  const session = await getSessionAuth();

  if (!session) {
    console.error('❌ Ticket creation failed: Authentication failed');
    return res.status(500).send("Auth failed");
  }

  const { csrf_token, session_id } = session;

  const email = `${from.replace(/\D/g, '')}@whatsapp.stickershop.co.uk`;

  try {
    const ticketResponse = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
      subject: `New WhatsApp message from ${from}`,
      channel: "EMAIL",
      requester: email, // Let Kayako find or assign based on email
      contents: [{
        type: "text",
        body: message
      }]
    }, {
      headers: {
        'X-CSRF-Token': csrf_token,
        'Cookie': `kayako_session_id=${session_id}`,
        'Content-Type': 'application/json'
      },
      auth: {
        username: process.env.KAYAKO_USERNAME,
        password: process.env.KAYAKO_PASSWORD
      }
    });

    console.log("✅ Ticket successfully created:", ticketResponse.data);
    res.send('<Response></Response>');
  } catch (error) {
    console.error("❌ Ticket creation failed:", error.response?.data || error.message);
    res.status(500).send("Ticket creation failed");
  }
});

app.get('/', (req, res) => res.send("Webhook is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));