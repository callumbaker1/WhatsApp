const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com/api/v1';
const KAYAKO_USERNAME = process.env.KAYAKO_USERNAME;
const KAYAKO_PASSWORD = process.env.KAYAKO_PASSWORD;

async function getSessionAuth() {
  const authString = Buffer.from(`${KAYAKO_USERNAME}:${KAYAKO_PASSWORD}`).toString('base64');

  try {
    const response = await axios.get(`${KAYAKO_BASE_URL}/cases.json`, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });

    const sessionId = response.data.session_id;
    const csrfHeader = response.headers['set-cookie'].find(c => c.includes('X-CSRF-Token'));
    const csrfToken = csrfHeader?.match(/X-CSRF-Token=([^;]+)/)?.[1];

    return { sessionId, csrfToken };
  } catch (error) {
    console.error("❌ Auth error:", error.response?.data || error.message);
    throw new Error('Authentication failed');
  }
}

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`📩 WhatsApp from ${from}: ${body}`);

  try {
    const { sessionId, csrfToken } = await getSessionAuth();

    await axios.post(`${KAYAKO_BASE_URL}/cases.json`, {
      subject: `WhatsApp from ${from}`,
      contents: body,
      requester_id: 1 // ⚠️ Replace with a real requester ID or user lookup later
    }, {
      headers: {
        'Cookie': `kayako_session_id=${sessionId}`,
        'X-CSRF-Token': csrfToken,
        'Content-Type': 'application/json'
      }
    });

    console.log("✅ Ticket created via session auth");
    res.send('<Response></Response>');
  } catch (error) {
    console.error("❌ Ticket creation failed:", error.response?.data || error.message);
    res.status(500).send("Ticket creation failed");
  }
});

app.get('/', (req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
