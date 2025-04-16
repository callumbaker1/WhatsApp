const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// 🔐 Kayako OAuth credentials from Render environment variables
const KAYAKO_BASE_URL = 'https://stickershop.kayako.com'; // 👈 Update to your Kayako URL
const CLIENT_ID = process.env.KAYAKO_CLIENT_ID;
const CLIENT_SECRET = process.env.KAYAKO_CLIENT_SECRET;

let accessToken = null;
let tokenExpiry = null;

// ✅ Fetch Kayako access token using client credentials
async function getAccessToken() {
  const response = await axios.post(`${KAYAKO_BASE_URL}/api/v1/token`, new URLSearchParams({
    grant_type: 'password',
    username: process.env.KAYAKO_USERNAME,
    password: process.env.KAYAKO_PASSWORD
  }));

  return response.data.access_token;
}

// ✅ Handle WhatsApp webhook from Twilio
app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`WhatsApp from ${from}: ${body}`);

  try {
    const token = await getAccessToken();

    await axios.post(`${KAYAKO_BASE_URL}/api/v1/tickets`, {
      subject: `WhatsApp from ${from}`,
      requester: {
        name: from,
        email: `${from.replace(/\D/g, '')}@stickershop.fake`
      },
      channel: "email",
      content: body
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log("✅ Ticket successfully created");
    res.send('<Response></Response>');
  } catch (error) {
    console.error("❌ Ticket creation failed:", error.response?.data || error.message);
    res.status(500).send("Ticket creation failed");
  }
});

// Optional: fallback route to test Render is live
app.get('/', (req, res) => {
  res.send("Webhook is running ✅");
});

// 🔄 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));