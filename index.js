const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const app = express();
require("dotenv").config();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const KAYAKO_BASE_URL = "https://stickershop.kayako.com/api/v1";

async function getSessionAuth() {
  try {
    const auth = Buffer.from(
      `${process.env.KAYAKO_USERNAME}:${process.env.KAYAKO_PASSWORD}`
    ).toString("base64");

    const response = await axios.post(
      `${KAYAKO_BASE_URL}/sessions.json`,
      {},
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );

    const cookie = response.headers["set-cookie"]?.find((c) =>
      c.includes("kayako_session")
    );
    const csrf = response.headers["x-csrf-token"];

    if (!cookie || !csrf) {
      console.error("❌ Missing session cookie or CSRF token");
      return null;
    }

    return {
      cookie: cookie.split(";")[0],
      csrf,
    };
  } catch (error) {
    console.error("❌ Auth error:", error.message);
    return null;
  }
}

app.post("/incoming-whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`📩 WhatsApp from ${from}: ${body}`);

  const session = await getSessionAuth();
  if (!session) {
    console.error("❌ Ticket creation failed: Missing session_id or cookie in response");
    return res.status(500).send("Auth failed");
  }

  try {
    const result = await axios.post(
      `${KAYAKO_BASE_URL}/cases.json`,
      {
        subject: `New WhatsApp message from ${from}`,
        contents: [
          {
            body,
            channel: "messenger",
            content_type: "plaintext",
          },
        ],
        requester_id: null, // optional if using cookie auth
        via: "messenger",
      },
      {
        headers: {
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Ticket created:", result.data?.id);
    res.send("<Response></Response>");
  } catch (error) {
    console.error("❌ Ticket creation failed:", error.response?.data || error.message);
    res.status(500).send("Ticket creation failed");
  }
});

app.get("/", (req, res) => res.send("Webhook is running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));