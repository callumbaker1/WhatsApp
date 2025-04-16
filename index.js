const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = 'https://stickershop.kayako.com/api/v1';

// Start a Kayako session and retrieve session_id + CSRF token
async function startKayakoSession() {
  const auth = Buffer.from(`${process.env.KAYAKO_USERNAME}:${process.env.KAYAKO_PASSWORD}`).toString('base64');

  try {
    const sessionResponse = await axios.get(`${KAYAKO_BASE_URL}/cases.json`, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      }
    });

    const session_id = sessionResponse.headers['set-cookie']?.find(c => c.includes('session_id'))?.split(';')[0]?.split('=')[1];
    const csrfToken = sessionResponse.headers['x-csrf-token'];

    if (!session_id || !csrfToken) {
      throw new Error('Missing session_id or CSRF token');
    }

    return { session_id, csrfToken };
  } catch (err) {
    console.error('Auth error:', err.message || err);
    throw new Error('Authentication failed');
  }
}

app.post('/incoming-whatsapp', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`WhatsApp from ${from}: ${body}`);

  try {
    const { session_id, csrfToken } = await startKayakoSession();

    const ticketResponse = await axios.post(`${KAYAKO_BASE_URL}/cases.json`, {
      subject: `WhatsApp from ${from}`,
      contents: body,
      requester_id: 1, // TODO: Replace with a valid requester_id
      channel: 'email'
    }, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': `session_id=${session_id}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('✅ Ticket created:', ticketResponse.data);
    res.send('<Response></Response>');
  } catch (error) {
    console.error('❌ Ticket creation failed:', error.response?.data || error.message);
    res.status(500).send('Ticket creation failed');
  }
});

app.get('/', (req, res) => res.send('Webhook is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));