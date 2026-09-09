// Absence requests.
//
// A delegate says ahead of a session that they cannot come, and gives a
// reason. A karyakar approves or denies it. Section 6 of the spec describes
// this; only the karyakar half existed until now.
//
// A pending request is not an absence, which is why it does not live in the
// attendance tab. It becomes one only when a karyakar approves it, or when a
// denied request is followed by a no-show.

import { readTab, appendRows, updateRowWhere } from './sheets.js';

const TAB = 'absence_requests';

// Requests close when the session begins. Someone taken ill that morning
// phones a karyakar, who can excuse them after the fact.
function hasStarted(session, today) {
  const start = session.session_date;
  return Boolean(start) && today >= start;
}

export function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}

export async function requestsFor(env, bkId, options) {
  const rows = await readTab(env, TAB, options);
  return rows.filter((row) => row.bk_id === bkId);
}

export async function pendingRequests(env) {
  const [rows, delegates, sessions] = await Promise.all([
    readTab(env, TAB),
    readTab(env, 'delegates'),
    readTab(env, 'sessions'),
  ]);
  const nameOf = new Map(
    delegates.map((row) => [row.bk_id, `${row.first_name} ${row.last_name}`.trim()])
  );
  const sessionOf = new Map(sessions.map((row) => [row.session_id, row]));

  return rows
    .filter((row) => row.state === 'pending')
    .map((row) => ({
      requestId: row.request_id,
      sessionId: row.session_id,
      bkId: row.bk_id,
      name: nameOf.get(row.bk_id) || row.bk_id,
      reason: row.reason,
      requestedAt: row.requested_at,
      sessionStart: sessionOf.get(row.session_id)?.session_date || '',
      sessionEnd: sessionOf.get(row.session_id)?.session_end_date || '',
      location: sessionOf.get(row.session_id)?.location || '',
    }))
    .sort((a, b) => String(a.sessionStart).localeCompare(String(b.sessionStart)));
}

export function requestState(rows, sessionId) {
  const mine = rows
    .filter((row) => row.session_id === sessionId)
    .sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)));
  return mine.length ? mine[mine.length - 1] : null;
}

export async function createRequest(env, session, bkId, reason) {
  const text = String(reason || '').trim();
  if (!text) return { error: 'Say why you cannot come.' };
  if (text.length > 500) return { error: 'Keep the reason under 500 characters.' };

  if (hasStarted(session, todayLocal())) {
    return {
      error: 'This session has already started. Ask a karyakar to excuse you.',
    };
  }

  const mine = await requestsFor(env, bkId, { fresh: true });
  const existing = requestState(mine, session.session_id);
  if (existing && existing.state === 'pending') {
    return { error: 'You already have a request waiting for this session.' };
  }
  if (existing && existing.state !== 'cancelled') {
    return { error: 'A karyakar has already decided this one.' };
  }

  await appendRows(env, TAB, [
    {
      request_id: crypto.randomUUID(),
      session_id: session.session_id,
      bk_id: bkId,
      reason: text,
      requested_at: new Date().toISOString(),
      state: 'pending',
      decided_by: '',
      decided_at: '',
      decision_note: '',
    },
  ]);
  return { ok: true };
}

export async function cancelRequest(env, session, bkId) {
  const mine = await requestsFor(env, bkId, { fresh: true });
  const existing = requestState(mine, session.session_id);
  if (!existing || existing.state !== 'pending') {
    return { error: 'There is no request waiting for this session.' };
  }
  await updateRowWhere(env, TAB, 'request_id', existing.request_id, {
    state: 'cancelled',
    decided_at: new Date().toISOString(),
  });
  return { ok: true };
}

// Approving records the absence immediately: an approved request means they
// are not coming, and the session leaves their grade.
//
// Denying records nothing in attendance. Section 6 is explicit that a denied
// delegate who turns up anyway gets a normal grade, so a denial must not
// pre-mark anyone absent. If they then fail to appear, closing the window
// records it as denied rather than as no request.
export async function decideRequest(env, requestId, decision, note, actorId) {
  // Fresh, never cached: deciding the same request twice would write the
  // absence twice.
  const rows = await readTab(env, TAB, { fresh: true });
  const request = rows.find((row) => row.request_id === requestId);
  if (!request) return { error: 'No such request.' };
  if (request.state !== 'pending') return { error: 'That request is already decided.' };

  if (decision === 'denied' && !String(note || '').trim()) {
    return { error: 'A denied request has to state a reason. The delegate is shown it.' };
  }
  if (!['approved', 'denied'].includes(decision)) {
    return { error: 'A request is approved or denied.' };
  }

  await updateRowWhere(env, TAB, 'request_id', requestId, {
    state: decision,
    decided_by: actorId,
    decided_at: new Date().toISOString(),
    decision_note: String(note || '').trim(),
  });
  return { ok: true, request };
}

// What a close should record for someone who never checked in: a denied
// request means the decision is the reason, not simply a no-show.
export async function deniedFor(env, sessionId) {
  const rows = await readTab(env, TAB);
  const denied = new Map();
  for (const row of rows) {
    if (row.session_id === sessionId && row.state === 'denied') {
      denied.set(row.bk_id, row.decision_note || '');
    }
  }
  return denied;
}
