// Authentication: PIN hashing, login tokens, and lockout.
//
// PIN hashes and failed-attempt counters live in KV, never in the Sheet. A
// 4-digit PIN has only 10,000 possibilities, so a hash sitting in a
// spreadsheet is recoverable by anyone who can open that spreadsheet.

const PBKDF2_ITERATIONS = 250000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 15 * 60;
const TOKEN_HOURS = 12;

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Constant-time comparison, so a wrong PIN cannot be narrowed down by timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function derive(pin, salt) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return base64url(bits);
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${hash}`;
}

export async function verifyPin(pin, stored) {
  const [scheme, , iterations, saltPart, hashPart] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !saltPart || !hashPart) return false;
  const salt = fromBase64url(saltPart);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: Number(iterations),
      hash: 'SHA-256',
    },
    key,
    256
  );
  return timingSafeEqual(base64url(bits), hashPart);
}

// A PIN is 4 to 6 digits, the length is the person's choice. Repeated and
// sequential digits are refused — they are the first thing anyone guesses.
export function pinProblem(pin) {
  if (!/^\d{4,6}$/.test(pin || '')) return 'PIN must be 4 to 6 digits.';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be the same digit repeated.';
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'PIN cannot be consecutive digits.';
  return null;
}

export const credentialKey = (id) => `pin:${id}`;
const lockKey = (id) => `lock:${id}`;

export async function getLockout(env, id) {
  const raw = await env.AUTH.get(lockKey(id));
  if (!raw) return { attempts: 0, locked: false };
  const state = JSON.parse(raw);
  return {
    attempts: state.attempts,
    locked: state.attempts >= MAX_ATTEMPTS,
    minutesLeft: Math.max(
      1,
      Math.ceil((state.until - Date.now()) / 60000)
    ),
  };
}

export async function recordFailure(env, id) {
  const current = await getLockout(env, id);
  const attempts = current.attempts + 1;
  await env.AUTH.put(
    lockKey(id),
    JSON.stringify({ attempts, until: Date.now() + LOCKOUT_SECONDS * 1000 }),
    { expirationTtl: LOCKOUT_SECONDS }
  );
  return { attempts, remaining: Math.max(0, MAX_ATTEMPTS - attempts) };
}

export async function clearFailures(env, id) {
  await env.AUTH.delete(lockKey(id));
}

// Login tokens are short-lived HS256 JWTs. They live in the browser's
// localStorage, because the site and this Worker are on different domains and
// Safari drops third-party cookies.
export async function signToken(env, payload) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_HOURS * 3600,
  };
  const claim =
    base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))) +
    '.' +
    base64url(encoder.encode(JSON.stringify(body)));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(claim));
  return claim + '.' + base64url(signature);
}

export async function verifyToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const claim = parts[0] + '.' + parts[1];
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64url(parts[2]),
    encoder.encode(claim)
  );
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
