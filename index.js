const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

// 🛠 Update with your actual Kayako credentials or use environment variables
const KAYAKO_USERNAME = process.env.KAYAKO_USERNAME || 'hello@stickershop.co.uk';
const KAYAKO_PASSWORD = process.env.KAYAKO_PASSWORD || 'Sunnyside25*';
const KAYAKO_BASE_URL = 'https://stickershop.kayako.com/api/v1';

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`📩 WhatsApp from ${from}: ${body}`);

  const authHeader = 'Basic ' + Buffer.from(`${KAYAKO_USERNAME}:${KAYAKO_PASSWORD}`).toString('base64');

  try {
    await axios.post(`${KAYAKO_BASE_URL}/cases.json`, {
      subject: `WhatsApp from ${from}`,
      requester: {
        name: from,
        email: `${from.replace(/\D/g, '')}@stickershop.fake`
      },
      channel: "email",
      content: body
    }, {
      headers: {
        Authorization: authHeader,
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

app.get('/', (req, res) => res.send("Webhook is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));