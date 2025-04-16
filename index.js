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

async function findOrCreateUser(email, name, authHeaders) {
  try {
    // 🔍 Try to find the user
    const searchResponse = await axios.get(`${KAYAKO_API_BASE}/users.json?query=${encodeURIComponent(email)}`, authHeaders);

    if (searchResponse.data && searchResponse.data.length > 0) {
      console.log("👤 Found existing user:", searchResponse.data[0].id);
      return searchResponse.data[0].id;
    }

    // ✳️ If not found, create one
    const createResponse = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name,
      email,
      role_id: 1,
      team_ids: [1]
    }, authHeaders);

    return createResponse.data.id;

  } catch (error) {
    if (error.response?.data?.errors?.some(e => e.code === "FIELD_DUPLICATE")) {
      // 🛑 If it's a duplicate email, search again and return that ID
      const retrySearch = await axios.get(`${KAYAKO_API_BASE}/users.json?query=${encodeURIComponent(email)}`, authHeaders);
      if (retrySearch.data && retrySearch.data.length > 0) {
        console.log("🔁 Resolved duplicate by returning existing user ID:", retrySearch.data[0].id);
        return retrySearch.data[0].id;
      }
    }

    console.error("❌ User search/create error:", error.response?.data || error.message);
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
  const name = from;

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

  if (!requester_id) {
    return res.status(500).send("User lookup/creation failed");
  }

  try {
    const ticketResponse = await axios.post(`${KAYAKO_API_BASE}/cases.json`, {
      subject: `New WhatsApp message from ${from}`,
      channel: "email",
      requester_id,
      contents: [
        {
          type: "text",
          body: message
        }
      ]
    }, authHeaders);

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
