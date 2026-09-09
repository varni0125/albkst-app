// Google Sheets access.
//
// The Worker authenticates as a service account: it signs a JWT with the
// service account's private key, trades it for an access token, and caches
// that token until shortly before it expires.
//
// The Sheet holds roster and program data only. Credentials live in the
// Account durable object.

let cachedToken = null; // { token, expiresAt }

// Google allows 60 reads per minute per service account. Twenty-five
// delegates checking in at once, each request reading whole tabs, goes past
// that in seconds and the app starts failing at the worst possible moment.
//
// So tab reads are cached in the isolate. How stale each tab may be is a
// judgement about what it costs to be wrong: a roster that is a minute out of
// date is fine, a check-in that is three seconds out of date is fine, and any
// write clears its own tab immediately.
const TAB_MAX_AGE_MS = {
  delegates: 60000,
  karyakars: 60000,
  sessions: 15000,
  attendance: 3000,
  scores: 5000,
};
const tabCache = new Map(); // tab -> { rows, at }
const headerCache = new Map(); // tab -> headers, which never change

function invalidate(tab) {
  tabCache.delete(tab);
}

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

async function headersFor(env, tab) {
  if (headerCache.has(tab)) return headerCache.get(tab);
  const data = await api(env, `/values/${encodeURIComponent(tab)}!1:1`);
  const headers = data.values?.[0] || [];
  if (headers.length) headerCache.set(tab, headers);
  return headers;
}

// Every row of a tab as an object keyed by the header row. `_row` is the
// spreadsheet row number, which updateRow needs.
export async function readTab(env, tab) {
  const cached = tabCache.get(tab);
  const maxAge = TAB_MAX_AGE_MS[tab] ?? 5000;
  if (cached && Date.now() - cached.at < maxAge) return cached.rows;

  const data = await api(env, `/values/${encodeURIComponent(tab)}`);
  const [headers, ...rows] = data.values || [[]];
  if (!headers || !headers.length) return [];
  if (!headerCache.has(tab)) headerCache.set(tab, headers);

  const records = rows.map((row, i) => {
    const record = { _row: i + 2 };
    headers.forEach((name, column) => {
      record[name] = row[column] ?? '';
    });
    return record;
  });
  tabCache.set(tab, { rows: records, at: Date.now() });
  return records;
}

export async function findRow(env, tab, key, value) {
  const rows = await readTab(env, tab);
  return rows.find((row) => row[key] === value) || null;
}

// Appends rows. Used for the attendance ledger, where concurrent writes must
// never overwrite each other.
export async function appendRows(env, tab, records) {
  if (!records.length) return;
  const headers = await headersFor(env, tab);
  const values = records.map((record) =>
    headers.map((name) => record[name] ?? '')
  );
  await api(
    env,
    `/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );
  invalidate(tab);
}

// Read-modify-write of one row, found by a key rather than by a remembered
// row number. A cached row number can be stale — a row inserted, deleted or
// sorted in the meantime would send the write to the wrong session — so the
// position is looked up fresh, uncached, at the moment of writing.
//
// Only for tabs a single karyakar edits at a time, never for attendance.
export async function updateRowWhere(env, tab, keyColumn, keyValue, patch) {
  const data = await api(env, `/values/${encodeURIComponent(tab)}`);
  const rows = data.values || [];
  const headers = rows[0] || [];
  const keyIndex = headers.indexOf(keyColumn);
  if (keyIndex < 0) throw new Error(`${tab} has no ${keyColumn} column`);

  const index = rows.findIndex((row, i) => i > 0 && row[keyIndex] === keyValue);
  if (index < 1) throw new Error(`No ${tab} row where ${keyColumn} is ${keyValue}`);

  const rowNumber = index + 1;
  const row = rows[index].slice();
  headers.forEach((name, i) => {
    if (name in patch) row[i] = patch[name];
    else if (row[i] === undefined) row[i] = '';
  });

  const range = `${encodeURIComponent(tab)}!A${rowNumber}:${columnLetter(headers.length)}${rowNumber}`;
  await api(env, `/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [row] }),
  });
  invalidate(tab);
}

function columnLetter(count) {
  let letter = '';
  let n = count;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
