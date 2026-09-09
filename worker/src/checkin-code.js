// The check-in code behind the QR.
//
// The code carries its own expiry, signed, so nothing is stored and the
// karyakar screen can show a truthful countdown. Generating a code makes one
// that lasts exactly thirty minutes, rather than however much is left of a
// fixed slot.
//
// Section 6 rejected QR codes because "a code with no time limit can be
// screenshotted and forwarded". This one has a time limit, and the check-in
// window is normally open for far less than its life. What it stops is
// checking in from somewhere else without ever seeing the code; what it does
// not stop is someone deliberately relaying a live code to a friend at home.

const LIFETIME_MINUTES = 30;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const SIGNATURE_LENGTH = 6;

const encoder = new TextEncoder();

async function sign(env, sessionId, expiryMinute) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`checkin|${sessionId}|${expiryMinute}`)
  );
  const bytes = new Uint8Array(signature);
  let out = '';
  for (let i = 0; i < SIGNATURE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const minutesNow = () => Math.floor(Date.now() / 60000);

export async function issueCode(env, sessionId) {
  const expiryMinute = minutesNow() + LIFETIME_MINUTES;
  const signature = await sign(env, sessionId, expiryMinute);
  return {
    code: `${expiryMinute.toString(32).toUpperCase()}-${signature}`,
    expiresAt: new Date(expiryMinute * 60000).toISOString(),
    secondsLeft: expiryMinute * 60 - Math.floor(Date.now() / 1000),
    lifetimeMinutes: LIFETIME_MINUTES,
  };
}

export async function codeIsValid(env, sessionId, candidate) {
  const given = String(candidate || '').trim().toUpperCase();
  const [expiryPart, signaturePart] = given.split('-');
  if (!expiryPart || !signaturePart) return false;

  const expiryMinute = parseInt(expiryPart, 32);
  if (!Number.isFinite(expiryMinute)) return false;

  // The expiry is inside the signature, so it cannot be extended by editing
  // the code; an expired one is simply refused.
  if (expiryMinute <= minutesNow()) return false;

  const expected = await sign(env, sessionId, expiryMinute);
  return timingSafeEqual(signaturePart, expected);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
