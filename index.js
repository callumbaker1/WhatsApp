const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

require('dotenv').config();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com'; // 👈 Your Kayako domain

// 🔐 Auth header using base64-encoded Basic Auth
const authHeader = 'Basic ' + Buffer.from(`${process.env.KAYAKO_USERNAME}:${process.env.KAYAKO_PASSWORD}`).toString('base64');

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`WhatsApp from ${from}: ${body}`);

  try {
    await axios.post(`${KAYAKO_BASE_URL}/api/v1/cases.json`, {
      subject: `WhatsApp from ${from}`,
      requester: {
        name: from,
        email: `${from.replace(/\D/g, '')}@stickershop.fake`
      },
      contents: [
        {
          channel: "email",
          body: body
        }
      ]
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
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));