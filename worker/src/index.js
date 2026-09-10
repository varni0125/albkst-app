// BKST API.
//
// Every decision about who someone is, what they may see, and what a grade is
// happens here. The frontend renders what this returns and decides nothing.

import { json, fail, preflight, readJson } from './http.js';
import { lookupAccount, normalizeId } from './accounts.js';
import { accountStore, Account } from './account-store.js';
import { hashPin, verifyPin, pinProblem, signToken, verifyToken } from './auth.js';
import {
  listSessions,
  findSession,
  rosterFor,
  setWindow,
  closeWindow,
  selfCheckin,
  markAttendance,
  attendanceProblem,
  standingFor,
} from './sessions.js';
import { issueCode } from './checkin-code.js';
import {
  createRequest,
  cancelRequest,
  decideRequest,
  pendingRequests,
} from './requests.js';
import { directory, delegateDetail, dashboard } from './people.js';
import { scheduleFor, addItem, editItem, removeItem, itemProblem, shiftFrom, shiftPreview } from './schedule.js';

export { Account };
export { CheckinBuffer } from './checkin-buffer.js';

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
      return fail(env, 409, 'No PIN set for this ID yet.', { needsPinSetup: true });
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

// First login only. Setting a PIN over an existing one is refused; replacing
// one is a karyakar reset.
async function handleSetPin(request, env) {
  const { id: rawId, pin } = await readJson(request);
  const id = normalizeId(rawId);
  if (!id) return fail(env, 400, BAD_CREDENTIALS);

  const problem = pinProblem(pin);
  if (problem) return fail(env, 400, problem);

  const account = await lookupAccount(env, id);
  if (!account) return fail(env, 401, BAD_CREDENTIALS);

  const { alreadySet } = await accountStore(env, id).setPin(await hashPin(pin));
  if (alreadySet) {
    return fail(env, 409, 'This ID already has a PIN. Ask a karyakar to reset it.');
  }

  return json(env, {
    token: await signToken(env, { sub: id, role: account.role }),
    account,
  });
}

async function handleResetPin(request, env, actor) {
  const { id: rawId } = await readJson(request);
  const id = normalizeId(rawId);
  const target = await lookupAccount(env, id);
  if (!target) return fail(env, 404, 'No active account with that ID.');

  await accountStore(env, id).resetPin();
  // Who reset whose PIN, and when. Section 11 of the spec asks for this.
  console.log(
    JSON.stringify({ event: 'pin_reset', by: actor.id, target: id, at: new Date().toISOString() })
  );
  return json(env, {
    ok: true,
    message: `${target.name} can now set a new PIN at their next sign in.`,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return preflight(env);

    try {
      if (method === 'GET' && path === '/health') return json(env, { ok: true });
      if (method === 'POST' && path === '/auth/login') return await handleLogin(request, env);
      if (method === 'POST' && path === '/auth/set-pin') return await handleSetPin(request, env);

      // Everything below needs a valid token.
      const account = await authenticate(request, env);
      if (!account) return fail(env, 401, 'Please log in again.');

      const karyakarOnly = () =>
        account.role === 'karyakar'
          ? null
          : fail(env, 403, 'That is not available to you.');

      if (method === 'GET' && path === '/me') return json(env, { account });

      if (method === 'GET' && path === '/me/standing') {
        if (account.role !== 'delegate') {
          return fail(env, 403, 'That is not available to you.');
        }
        return json(env, await standingFor(env, account.id));
      }

      if (method === 'POST' && path === '/auth/reset-pin') {
        return karyakarOnly() || (await handleResetPin(request, env, account));
      }

      if (method === 'GET' && path === '/sessions') {
        return json(env, { sessions: await listSessions(env, account.role === 'karyakar') });
      }

      if (method === 'GET' && path === '/delegates') {
        return karyakarOnly() || json(env, await directory(env));
      }

      const delegateMatch = path.match(/^\/delegates\/([A-Za-z0-9_-]+)$/);
      if (method === 'GET' && delegateMatch) {
        const denied = karyakarOnly();
        if (denied) return denied;
        const detail = await delegateDetail(env, delegateMatch[1]);
        if (!detail) return fail(env, 404, 'No such delegate.');
        return json(env, detail);
      }

      if (method === 'GET' && path === '/dashboard') {
        return karyakarOnly() || json(env, await dashboard(env));
      }

      if (method === 'GET' && path === '/requests') {
        return karyakarOnly() || json(env, { requests: await pendingRequests(env) });
      }

      const decisionMatch = path.match(/^\/requests\/([A-Za-z0-9-]+)\/decision$/);
      if (method === 'POST' && decisionMatch) {
        const denied = karyakarOnly();
        if (denied) return denied;
        const { decision, note } = await readJson(request);
        const result = await decideRequest(env, decisionMatch[1], decision, note, account.id);
        if (result.error) return fail(env, 400, result.error);

        // An approved request is an excused absence, recorded straight away.
        if (decision === 'approved') {
          const session = await findSession(env, result.request.session_id);
          if (session) {
            await markAttendance(
              env,
              session,
              {
                bkId: result.request.bk_id,
                status: 'absent',
                absenceOutcome: 'approved',
                reason: result.request.reason,
                decisionNote: String(note || '').trim(),
              },
              account.id
            );
          }
        }
        return json(env, { ok: true, dashboard: await dashboard(env) });
      }

      const sessionMatch = path.match(/^\/sessions\/([A-Za-z0-9_-]+)(\/[a-z-]+)?$/);
      if (sessionMatch) {
        const session = await findSession(env, sessionMatch[1]);
        if (!session) return fail(env, 404, 'No such session.');
        const action = sessionMatch[2] || '';

        if (method === 'GET' && action === '') {
          const denied = karyakarOnly();
          if (denied) return denied;
          return json(env, {
            session: (await listSessions(env)).find((s) => s.id === session.session_id),
            roster: await rosterFor(env, session.session_id),
          });
        }

        if (method === 'POST' && action === '/window') {
          const denied = karyakarOnly();
          if (denied) return denied;
          const { state } = await readJson(request);
          if (state === 'open') {
            return json(env, { session: await setWindow(env, session, 'open') });
          }
          if (state === 'closed') {
            const result = await closeWindow(env, session, account.id);
            return json(env, {
              session: (await listSessions(env)).find((s) => s.id === session.session_id),
              roster: await rosterFor(env, session.session_id),
              markedAbsent: result.markedAbsent,
            });
          }
          return fail(env, 400, 'Check-in can only be opened or closed.');
        }

        if (method === 'POST' && action === '/attendance') {
          const denied = karyakarOnly();
          if (denied) return denied;
          const entry = await readJson(request);
          const problem = await attendanceProblem(env, entry);
          if (problem) return fail(env, 400, problem);
          await markAttendance(env, session, entry, account.id);
          return json(env, { roster: await rosterFor(env, session.session_id) });
        }

        // The karyakar taps generate; this hands back a code good for thirty
        // minutes, which their screen draws as a QR with a countdown.
        if (method === 'POST' && action === '/checkin-code') {
          const denied = karyakarOnly();
          if (denied) return denied;
          if (session.checkin_state !== 'open') {
            return fail(env, 409, 'Open check-in first, then generate a code.');
          }
          return json(env, await issueCode(env, session.session_id));
        }

        // The programme. Delegates read it; karyakars change it.
        if (method === 'GET' && action === '/schedule') {
          return json(env, await scheduleFor(env, session));
        }

        if (method === 'POST' && action === '/schedule') {
          const denied = karyakarOnly();
          if (denied) return denied;
          const entry = await readJson(request);
          const problem = itemProblem(entry);
          if (problem) return fail(env, 400, problem);
          await addItem(env, session.session_id, entry);
          return json(env, await scheduleFor(env, session));
        }

        if (method === 'POST' && action === '/schedule-edit') {
          const denied = karyakarOnly();
          if (denied) return denied;
          const entry = await readJson(request);
          if (!entry.id) return fail(env, 400, 'Which item?');
          if (entry.remove) {
            await removeItem(env, entry.id);
            return json(env, await scheduleFor(env, session));
          }
          const problem = itemProblem(entry);
          if (problem) return fail(env, 400, problem);
          await editItem(env, entry.id, entry);
          return json(env, await scheduleFor(env, session));
        }

        // Moving a run of the day, either after an edit or because it is
        // simply running late.
        if (method === 'POST' && action === '/schedule-shift') {
          const denied = karyakarOnly();
          if (denied) return denied;
          const { day, afterTime, includeAnchor, minutes, preview } = await readJson(request);
          if (!day || !afterTime) return fail(env, 400, 'Which day, and from when?');

          if (preview) {
            const moving = await shiftPreview(env, session.session_id, day, afterTime, includeAnchor);
            return json(env, {
              moving: moving.map((row) => ({ item: row.item, time: row.start_time })),
            });
          }

          if (!Number.isFinite(Number(minutes)) || Number(minutes) === 0) {
            return fail(env, 400, 'By how many minutes?');
          }
          const moved = await shiftFrom(
            env, session.session_id, day, afterTime, includeAnchor, Number(minutes)
          );
          return json(env, { moved, ...(await scheduleFor(env, session)) });
        }

        if (method === 'POST' && action === '/absence-request') {
          if (account.role !== 'delegate') {
            return fail(env, 403, 'Only delegates request an absence.');
          }
          const { reason } = await readJson(request);
          const result = await createRequest(env, session, account.id, reason);
          if (result.error) return fail(env, 409, result.error);
          return json(env, { ok: true, standing: await standingFor(env, account.id) });
        }

        if (method === 'POST' && action === '/cancel-request') {
          if (account.role !== 'delegate') {
            return fail(env, 403, 'Only delegates cancel their own request.');
          }
          const result = await cancelRequest(env, session, account.id);
          if (result.error) return fail(env, 409, result.error);
          return json(env, { ok: true, standing: await standingFor(env, account.id) });
        }

        if (method === 'POST' && action === '/checkin') {
          if (account.role !== 'delegate') {
            return fail(env, 403, 'Only delegates check themselves in.');
          }
          const { code } = await readJson(request);
          const result = await selfCheckin(env, session, account.id, code);
          if (!result.ok) return fail(env, 409, result.error);
          return json(env, result);
        }
      }

      return fail(env, 404, 'Not found.');
    } catch (error) {
      // The detail goes to the log, never to the browser.
      console.error(method, path, error.stack || error.message);
      return fail(env, 500, 'Something went wrong. Try again.');
    }
  },
};
