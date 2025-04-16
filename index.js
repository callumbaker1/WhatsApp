const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Use env vars in Render for credentials
const KAYAKO_API_URL = 'https://stickershop.kayako.com/api/v1';
const KAYAKO_API_USER = process.env.KAYAKO_API_USER;
const KAYAKO_API_PASS = process.env.KAYAKO_API_PASS;

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`WhatsApp from ${from}: ${body}`);

  try {
    await axios.post(`${KAYAKO_API_URL}/tickets`, {
      subject: `WhatsApp from ${from}`,
      requester: {
        name: from,
        email: `${from.replace(/\D/g, '')}@stickershop.fake`
      },
      channel: "email",
      content: body
    }, {
      auth: {
        username: KAYAKO_API_USER,
        password: KAYAKO_API_PASS
      }
    });

    res.send('<Response></Response>');
  } catch (error) {
    console.error('Ticket creation failed:', error.message);
    res.status(500).send('Ticket creation failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
