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

    console.log("🛡 CSRF Token:", csrf_token);
console.log("🍪 Session ID:", session_id);

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
  const email1 = "callumbakes123432@icloud.com";
  try {
    console.log("🔍 Searching for user with email:", email1);
    const searchResponse = await axios.get(`${KAYAKO_API_BASE}/search.json?query=${email1}&resources=users`, authHeaders);

    console.log(searchResponse);

    const users = searchResponse.data?.data || [];

    if (users.length > 0) {
      const matchedUser = users.find(u =>
        (u.emails || []).some(e => e.email === email1)
      );
      if (matchedUser) {
        console.log("✅ Exact user match found:", matchedUser.id);
        return matchedUser.id;
      }
    }

    console.log("👤 User not found, creating new one...");

    const createResponse = await axios.post(`${KAYAKO_API_BASE}/users.json`, {
      full_name: name,
      role_id: 4,
      email: email1
    }, authHeaders);

    // ✅ Safely extract the new user ID
    console.log("🔍 Full create response:", createResponse.data);

    const newUserId = createResponse.data?.data?.id || createResponse.data?.id;

    if (!newUserId) {
      console.error("❌ User created but no ID returned.");
      return null;
    }

    console.log("✅ User created:", newUserId);
    return newUserId;

  } catch (error) {
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

  const phoneNumber = from.replace(/^whatsapp:/, '').replace(/^\+/, '');
  const email = `${phoneNumber}@whatsapp.stickershop.co.uk`;

  console.log("📧 Lookup email:", email);

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
    console.error('❌ No requester_id returned — user lookup or creation failed');
    return res.status(500).send("User lookup/creation failed");
  }
  
  console.log("✅ Requester ID found or created:", requester_id);

  try {
    const ticketPayload = {
      subject: `New WhatsApp message from ${from}`,
      requester_id,
      team_id: 3,
      type: "question",
      channel: "email", // ✅ THIS is what was still missing
      contents: [
        {
          type: "text",
          body: message,
          via: "user"
        }
      ]
    };
    
    console.log("📦 Payload to Kayako:\n", JSON.stringify(ticketPayload, null, 2)); // ← log payload
    
    const ticketResponse = await axios.post(`${KAYAKO_API_BASE}/cases.json`, ticketPayload, authHeaders);

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
