// BKST API.
//
// Every decision about who someone is, what they may see, and what a grade is
// happens here. The frontend renders what this returns and decides nothing.

import { json, fail, preflight, readJson } from './http.js';
import { lookupAccount, normalizeId } from './accounts.js';
import { accountStore, Account } from './account-store.js';
import {
  hashPin,
  verifyPin,
  pinProblem,
  signToken,
  verifyToken,
} from './auth.js';

export { Account };

// Deliberately identical for an unknown ID, a deactivated account, and a wrong
// PIN. Anything more specific tells a guesser which IDs are worth attacking.
const BAD_CREDENTIALS = 'That ID or PIN is not right.';

const lockedMessage = (minutes) =>
  `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, or ask a karyakar to reset your PIN.`;

// Verifies the token, then re-checks the account against the roster. A
// delegate dismissed an hour ago must not keep working on an unexpired token.
async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = await verifyToken(env, token);
  if (!payload) return null;
  return await lookupAccount(env, payload.sub);
}

async function handleLogin(request, env) {
  const { id: rawId, pin } = await readJson(request);
  const id = normalizeId(rawId);
  if (!id || !pin) return fail(env, 400, BAD_CREDENTIALS);

  const store = accountStore(env, id);
  const state = await store.load();
  if (state.locked) return fail(env, 429, lockedMessage(state.minutesLeft));

  const account = await lookupAccount(env, id);

  // An unknown ID is still run through a hash so that a wrong ID and a wrong
  // PIN take the same amount of time to answer.
  if (!account || !state.hasPin) {
    await verifyPin(pin, await hashPin('000000'));
    if (account && !state.hasPin) {
      return fail(env, 409, 'No PIN set for this ID yet.', {
        needsPinSetup: true,
      });
    }
    await store.recordFailure();
    return fail(env, 401, BAD_CREDENTIALS);
  }

  if (!(await verifyPin(pin, state.pinHash))) {
    const { remaining, locked } = await store.recordFailure();
    if (locked) return fail(env, 429, lockedMessage(15));
    return fail(
      env,
      401,
      `${BAD_CREDENTIALS} ${remaining} ${remaining === 1 ? 'try' : 'tries'} left before this ID locks for 15 minutes.`
    );
  }

  await store.clearFailures();
  return json(env, {
    token: await signToken(env, { sub: id, role: account.role }),
    account,
  });
}

// First login only. Setting a PIN over an existing one is refused — that path
// is a karyakar reset, which is Phase 1 work still to come.
async function handleSetPin(request, env) {
  const { id: rawId, pin } = await readJson(request);
  const id = normalizeId(rawId);
  if (!id) return fail(env, 400, BAD_CREDENTIALS);

  const problem = pinProblem(pin);
  if (problem) return fail(env, 400, problem);

  const account = await lookupAccount(env, id);
  if (!account) return fail(env, 401, BAD_CREDENTIALS);

  const store = accountStore(env, id);
  const { alreadySet } = await store.setPin(await hashPin(pin));
  if (alreadySet) {
    return fail(
      env,
      409,
      'This ID already has a PIN. Ask a karyakar to reset it.'
    );
  }

  return json(env, {
    token: await signToken(env, { sub: id, role: account.role }),
    account,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (request.method === 'OPTIONS') return preflight(env);

    try {
      switch (route) {
        case 'GET /health':
          return json(env, { ok: true });

        case 'POST /auth/login':
          return await handleLogin(request, env);

        case 'POST /auth/set-pin':
          return await handleSetPin(request, env);

        case 'GET /me': {
          const account = await authenticate(request, env);
          if (!account) return fail(env, 401, 'Please log in again.');
          return json(env, { account });
        }

        default:
          return fail(env, 404, 'Not found.');
      }
    } catch (error) {
      // The detail goes to the log, never to the browser.
      console.error(route, error.stack || error.message);
      return fail(env, 500, 'Something went wrong. Try again.');
    }
  },
};
