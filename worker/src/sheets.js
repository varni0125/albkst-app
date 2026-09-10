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
// How stale each tab may be. These are generous on purpose: the read limit is
// sixty a minute and thirty people arriving at once will spend them.
//
// Correctness does not rest on these numbers. Anything that decides on current
// state reads past the cache entirely, and the check-in window lives in a
// durable object rather than here.
const TAB_MAX_AGE_MS = {
  // The roster changes rarely, but when it does someone is standing there
  // waiting to see it. Five minutes was long enough that removing a delegate
  // looked like it had not worked.
  delegates: 60000,
  karyakars: 60000,
  sessions: 60000,        // the window state is not read from here
  attendance: 10000,      // a delegate's own screen polls every eight seconds
  scores: 30000,
  absence_requests: 10000,
  schedule: 60000,        // set before a session and rarely touched during it
};
const tabCache = new Map(); // tab -> { rows, at }
const headerCache = new Map(); // tab -> headers, which never change

// Every tab this app reads. A cache miss fetches all of them in one request
// rather than one request per tab.
//
// Google counts requests, not rows, and the whole spreadsheet is a few
// hundred rows. Twenty-five delegates opening the app at once, each request
// reading four tabs separately, was a hundred reads against a limit of sixty
// a minute — and the seventh person onwards got an error. One batched read
// makes that twenty-five, and warms every tab at the same time.
const ALL_TABS = [
  'delegates',
  'karyakars',
  'sessions',
  'attendance',
  'scores',
  'absence_requests',
  'schedule',
];

// Concurrent requests inside one isolate share a single fetch instead of
// each starting their own.
let inFlight = null;

function invalidate(tab) {
  tabCache.delete(tab);
}

function toRecords(values) {
  const [headers, ...rows] = values || [[]];
  if (!headers || !headers.length) return { headers: [], records: [] };
  const records = rows.map((row, i) => {
    const record = { _row: i + 2 };
    headers.forEach((name, column) => {
      record[name] = row[column] ?? '';
    });
    return record;
  });
  return { headers, records };
}

async function fetchAllTabs(env) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const ranges = ALL_TABS.map((tab) => `ranges=${encodeURIComponent(tab)}`).join('&');
    const data = await api(env, `/values:batchGet?${ranges}`);
    const at = Date.now();
    for (const valueRange of data.valueRanges || []) {
      const tab = String(valueRange.range || '').split('!')[0].replace(/^'|'$/g, '');
      if (!tab) continue;
      const { headers, records } = toRecords(valueRange.values);
      if (headers.length) headerCache.set(tab, headers);
      tabCache.set(tab, { rows: records, at });
    }
  })();
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
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

// Google's limit is sixty requests a minute, and a check-in rush can brush
// against it. A throttled call waits and tries again rather than failing the
// person standing in front of you; the jitter stops twenty-five retries
// arriving back in step.
async function api(env, path, init = {}, attempt = 0) {
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

  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const wait = 400 * 2 ** attempt + Math.random() * 400;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return api(env, path, init, attempt + 1);
  }

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
// `fresh` skips the cache. Needed wherever a decision depends on current
// state: the cache lives in one isolate and a write only clears that one, so
// another isolate can serve a stale copy and let the same decision be applied
// twice.
export async function readTab(env, tab, { fresh = false } = {}) {
  const cached = tabCache.get(tab);
  const maxAge = TAB_MAX_AGE_MS[tab] ?? 5000;
  if (!fresh && cached && Date.now() - cached.at < maxAge) return cached.rows;

  // One tab only, when the caller needs to be certain it is current.
  if (fresh) {
    const data = await api(env, `/values/${encodeURIComponent(tab)}`);
    const { headers, records } = toRecords(data.values);
    if (headers.length) headerCache.set(tab, headers);
    tabCache.set(tab, { rows: records, at: Date.now() });
    return records;
  }

  try {
    await fetchAllTabs(env);
  } catch (error) {
    // Google refused, most likely because a roomful of people arrived at once.
    // Slightly old data beats an error message: the alternative is telling
    // someone their screen is broken when it is merely a few seconds behind.
    if (cached) {
      console.warn('serving stale', tab, error.message);
      return cached.rows;
    }
    throw error;
  }
  return tabCache.get(tab)?.rows || [];
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
  // Written into the existing empty rows, not inserted as new ones.
  //
  // INSERT_ROWS makes a fresh row, and a fresh row copies the formatting of
  // the row above it. On an empty tab that row is the header, so the first
  // attendance row written came out navy with cream bold text, and every row
  // after inherited it. Writing into rows that are already formatted avoids
  // the whole problem.
  await api(
    env,
    `/values/${encodeURIComponent(tab)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );

  // The rows just written are added to the cache rather than the cache being
  // thrown away. Discarding it meant every check-in in a rush forced the next
  // one to re-read the whole spreadsheet, which is how twenty-five check-ins
  // became fifty API calls and nine people got an error.
  const cached = tabCache.get(tab);
  if (cached) {
    cached.rows = cached.rows.concat(
      records.map((record) => {
        const row = { _row: null };
        for (const name of headers) row[name] = record[name] ?? '';
        return row;
      })
    );
  }
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

// Several rows in one request. Shifting a running order back half an hour can
// touch fourteen rows, and Google serialises writes to a spreadsheet, so
// fourteen separate updates would be fourteen times as slow.
export async function updateRowsWhere(env, tab, keyColumn, updates) {
  if (!updates.length) return 0;

  const data = await api(env, `/values/${encodeURIComponent(tab)}`);
  const rows = data.values || [];
  const headers = rows[0] || [];
  const keyIndex = headers.indexOf(keyColumn);
  if (keyIndex < 0) throw new Error(`${tab} has no ${keyColumn} column`);

  const lastColumn = columnLetter(headers.length);
  const payload = [];
  for (const { key, patch } of updates) {
    const index = rows.findIndex((row, i) => i > 0 && row[keyIndex] === key);
    if (index < 1) continue;
    const row = rows[index].slice();
    headers.forEach((name, i) => {
      if (name in patch) row[i] = patch[name];
      else if (row[i] === undefined) row[i] = '';
    });
    const number = index + 1;
    payload.push({
      range: `${tab}!A${number}:${lastColumn}${number}`,
      values: [row],
    });
  }
  if (!payload.length) return 0;

  await api(env, '/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: payload }),
  });
  invalidate(tab);
  return payload.length;
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
