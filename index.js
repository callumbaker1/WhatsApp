// --- add these helpers to your file ---

/** Try to find the most recently updated ACTIVE case for a requester. */
async function findActiveCaseForRequester(requesterId, email, authHeaders) {
  // 1) Try filtered cases endpoint (works on many Kayako stacks)
  try {
    const r = await axios.get(
      `${KAYAKO_API_BASE}/cases.json`,
      {
        ...authHeaders,
        params: {
          requester_id: requesterId,
          state: 'ACTIVE',          // only active cases
          sort: 'updated_at',
          order: 'desc',
          limit: 1
        }
      }
    );
    const rows = r.data?.data || r.data || [];
    if (rows.length) {
      const id = rows[0].id || rows[0].data?.id;
      if (id) {
        console.log('🔎 Reusing latest ACTIVE case via /cases:', id);
        return id;
      }
    }
  } catch (err) {
    console.warn('↪︎ /cases filter not available; will fall back to search.', err.response?.data || err.message);
  }

  // 2) Fallback: use the search API and filter client-side
  try {
    // Searching by email is usually reliable; resources=cases returns case hits
    const s = await axios.get(
      `${KAYAKO_API_BASE}/search.json?query=${encodeURIComponent(email)}&resources=cases`,
      authHeaders
    );
    const hits = s.data?.data || [];
    // Pick the most recently updated ACTIVE case
    const candidates = hits
      .filter(h => (h.state || '').toUpperCase() === 'ACTIVE')
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    if (candidates.length) {
      console.log('🔎 Reusing ACTIVE case via /search:', candidates[0].id);
      return candidates[0].id;
    }
  } catch (err) {
    console.warn('↪︎ /search fallback failed:', err.response?.data || err.message);
  }

  return null;
}

/** Add a PUBLIC MESSAGE to a case (same helper I gave earlier). */
async function addPublicMessage(caseId, bodyText, authHeaders, subject = '') {
  const attempts = [
    {
      url: `${KAYAKO_API_BASE}/messages.json`,
      payload: {
        case_id: caseId,
        status: 'SENT',            // public
        direction: 'INCOMING',     // from customer
        subject,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    },
    {
      url: `${KAYAKO_API_BASE}/posts.json`,
      payload: {
        case_id: caseId,
        type: 'message',
        is_public: true,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    },
    {
      url: `${KAYAKO_API_BASE}/cases/${caseId}/messages.json`,
      payload: {
        status: 'SENT',
        direction: 'INCOMING',
        subject,
        contents: [{ type: 'text', body: bodyText }],
        channel: 'email'
      }
    }
  ];

  for (const a of attempts) {
    try {
      const resp = await axios.post(a.url, a.payload, authHeaders);
      console.log(`✉️ Public message posted via ${a.url}:`, resp.data?.id || resp.data);
      return true;
    } catch (err) {
      console.warn(`↪︎ Message attempt failed @ ${a.url}`, err.response?.data || err.message);
    }
  }
  return false;
}