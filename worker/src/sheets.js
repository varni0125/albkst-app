// Google Sheets access.
//
// The Worker authenticates as a service account: it signs a JWT with the
// service account's private key, trades it for an access token, and caches
// that token until shortly before it expires.
//
// The Sheet holds roster and program data only. Credentials live in KV.

let cachedToken = null; // { token, expiresAt }

function pemToBinary(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function base64url(input) {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const claim =
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
    '.' +
    base64url(
      JSON.stringify({
        iss: env.GOOGLE_SA_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    );

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(env.GOOGLE_SA_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(claim)
  );

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: claim + '.' + base64url(signature),
    }),
  });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Sheets auth failed: ' + JSON.stringify(data));
  }

  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return cachedToken.token;
}

async function api(env, path, init = {}) {
  const token = await getAccessToken(env);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}${path}`,
    {
      ...init,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Sheets ${response.status}: ${data.error?.message || 'request failed'}`
    );
  }
  return data;
}

// Every row of a tab as an object keyed by the header row.
export async function readTab(env, tab) {
  const data = await api(env, `/values/${encodeURIComponent(tab)}`);
  const [headers, ...rows] = data.values || [[]];
  if (!headers) return [];
  return rows.map((row) => {
    const record = {};
    headers.forEach((name, i) => {
      record[name] = row[i] ?? '';
    });
    return record;
  });
}

export async function findRow(env, tab, key, value) {
  const rows = await readTab(env, tab);
  return rows.find((row) => row[key] === value) || null;
}

// Appends a row. Used for the attendance ledger, where concurrent writes must
// never overwrite each other.
export async function appendRow(env, tab, record) {
  const data = await api(env, `/values/${encodeURIComponent(tab)}!1:1`);
  const headers = data.values?.[0] || [];
  const row = headers.map((name) => record[name] ?? '');
  await api(
    env,
    `/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) }
  );
}
