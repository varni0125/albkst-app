// Sessions, the check-in window, and attendance.
//
// Attendance is an append-only ledger: every check-in and every karyakar mark
// adds a row and the most recent row for a delegate and session wins. That is
// what makes twenty-five simultaneous check-ins safe, and what makes an
// automatic absent mark reversible without losing the history.

import { readTab, appendRows, updateRowWhere } from './sheets.js';
import { codeIsValid } from './checkin-code.js';
import { deniedFor, requestsFor, requestState, todayLocal } from './requests.js';

const CENTER_ORDER = ['Birmingham', 'Dothan', 'Huntsville', 'Mobile', 'Montgomery'];
const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

export const WINDOW_STATES = ['closed', 'open', 'closed_manually'];
const ABSENCE_OUTCOMES = ['approved', 'denied', 'no_request'];

// What a karyakar is allowed to record. The browser asks for a reason before
// it will submit a denial, but the browser is not where this is decided:
// section 6 requires a denial to state a reason because the delegate is shown
// it, and a rule that only exists in the page is not a rule.
export async function attendanceProblem(env, entry) {
  if (!entry || !entry.bkId) return 'A delegate is needed.';
  if (!['present', 'absent'].includes(entry.status)) {
    return 'A status of present or absent is needed.';
  }

  const delegates = await readTab(env, 'delegates');
  const person = delegates.find(
    (row) => row.bk_id === String(entry.bkId) && isTrue(row.active)
  );
  if (!person) return 'That is not an active delegate.';

  if (entry.status === 'absent') {
    const outcome = entry.absenceOutcome || 'no_request';
    if (!ABSENCE_OUTCOMES.includes(outcome)) {
      return 'An absence is approved, denied, or no_request.';
    }
    if (outcome === 'denied' && !String(entry.decisionNote || '').trim()) {
      return 'A denied absence has to state a reason. The delegate is shown it.';
    }
  }
  return null;
}

function publicSession(row) {
  return {
    id: row.session_id,
    term: row.term,
    startDate: row.session_date,
    endDate: row.session_end_date,
    location: row.location,
    startTime: row.start_time,
    checkinState: row.checkin_state || 'closed',
    checkinOpen: row.checkin_state === 'open',
  };
}

export async function listSessions(env) {
  const rows = await readTab(env, 'sessions');
  return rows
    .filter((row) => row.session_id)
    .map(publicSession)
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
}

export async function findSession(env, sessionId) {
  const rows = await readTab(env, 'sessions');
  return rows.find((row) => row.session_id === sessionId) || null;
}

// The current attendance state, one entry per delegate per session: the most
// recently marked row wins.
//
// Recency comes from marked_at, not from position in the sheet. Row order
// would be simpler, but it would also mean that a karyakar sorting the
// attendance tab silently changes who counts as present.
async function reconcile(env) {
  const rows = await readTab(env, 'attendance');
  const latest = new Map();
  for (const row of rows) {
    if (!row.session_id || !row.bk_id) continue;
    const key = `${row.session_id}|${row.bk_id}`;
    const held = latest.get(key);
    if (!held || String(row.marked_at) >= String(held.marked_at)) {
      latest.set(key, row);
    }
  }
  return latest;
}

// Counted across every session, approved or not — an approved absence still
// spends the allowance. Computed on read rather than trusted from the sheet,
// because it is the highest-stakes number in the app and a stored copy goes
// stale the moment a karyakar changes a mark.
function absenceCounts(latest) {
  const counts = new Map();
  for (const row of latest.values()) {
    if (row.status !== 'absent') continue;
    counts.set(row.bk_id, (counts.get(row.bk_id) || 0) + 1);
  }
  return counts;
}

export async function rosterFor(env, sessionId) {
  const [delegates, latest] = await Promise.all([
    readTab(env, 'delegates'),
    reconcile(env),
  ]);
  const counts = absenceCounts(latest);

  const people = delegates
    .filter((row) => row.bk_id && isTrue(row.active))
    .map((row) => {
      const record = latest.get(`${sessionId}|${row.bk_id}`) || null;
      return {
        bkId: row.bk_id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        grade: row.grade,
        center: row.center,
        status: record ? record.status : 'not_checked_in',
        absenceOutcome: record ? record.absence_outcome : '',
        source: record ? record.source : '',
        reason: record ? record.reason : '',
        decisionNote: record ? record.decision_note : '',
        absencesUsed: counts.get(row.bk_id) || 0,
      };
    });

  // A centre not in the known order goes last rather than first, which is
  // what indexOf returning -1 would otherwise do.
  const rank = (center) => {
    const i = CENTER_ORDER.indexOf(center);
    return i < 0 ? CENTER_ORDER.length : i;
  };
  const centers = [...new Set(people.map((p) => p.center))].sort(
    (a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b))
  );

  return {
    total: people.length,
    present: people.filter((p) => p.status === 'present').length,
    absent: people.filter((p) => p.status === 'absent').length,
    groups: centers.map((center) => {
      const members = people
        .filter((p) => p.center === center)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        center,
        present: members.filter((p) => p.status === 'present').length,
        total: members.length,
        members,
      };
    }),
  };
}

export async function setWindow(env, session, state) {
  await updateRowWhere(env, 'sessions', 'session_id', session.session_id, {
    checkin_state: state,
  });
  return { ...publicSession(session), checkinState: state, checkinOpen: state === 'open' };
}

function attendanceRow({ sessionId, bkId, status, outcome, reason, note, source, actorId }) {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    bk_id: bkId,
    status,
    absence_outcome: status === 'absent' ? outcome || 'no_request' : '',
    absence_number: '',
    reason: reason || '',
    decision_note: note || '',
    decided_by: status === 'absent' && outcome ? actorId : '',
    decided_at: status === 'absent' && outcome ? now : '',
    source,
    marked_at: now,
    marked_by: actorId,
  };
}

function hasEnded(session) {
  const end = session.session_end_date || session.session_date;
  return Boolean(end) && todayLocal() > end;
}

// A delegate checking themselves in. Refused unless the window is open and the
// session has not already happened — both checked here, not in the browser.
export async function selfCheckin(env, session, bkId, code) {
  if (hasEnded(session)) {
    return { ok: false, error: 'That session is over.' };
  }
  if (session.checkin_state !== 'open') {
    return { ok: false, error: 'Check-in is not open for this session.' };
  }
  // Proof of being in the room. Without it a delegate could check in from
  // home while the window is open.
  if (!(await codeIsValid(env, session.session_id, code))) {
    return {
      ok: false,
      error: 'That code has expired. Scan the code on the karyakar screen again.',
    };
  }
  const latest = await reconcile(env);
  const existing = latest.get(`${session.session_id}|${bkId}`);
  if (existing && existing.status === 'present') {
    return { ok: true, alreadyCheckedIn: true };
  }
  await appendRows(env, 'attendance', [
    attendanceRow({
      sessionId: session.session_id,
      bkId,
      status: 'present',
      source: 'self_checkin',
      actorId: bkId,
    }),
  ]);
  return { ok: true, alreadyCheckedIn: false };
}

export async function markAttendance(env, session, entry, actorId) {
  await appendRows(env, 'attendance', [
    attendanceRow({
      sessionId: session.session_id,
      bkId: entry.bkId,
      status: entry.status,
      outcome: entry.absenceOutcome,
      reason: entry.reason,
      note: entry.decisionNote,
      source: 'karyakar_marked',
      actorId,
    }),
  ]);
}

// Closing the window marks everyone who never checked in as absent, with no
// request recorded. Reversible: a later row wins, and the automatic row stays
// in the ledger as history.
export async function closeWindow(env, session, actorId) {
  const [delegates, latest, denied] = await Promise.all([
    readTab(env, 'delegates'),
    reconcile(env),
    deniedFor(env, session.session_id),
  ]);

  const unmarked = delegates
    .filter((row) => row.bk_id && isTrue(row.active))
    .filter((row) => !latest.has(`${session.session_id}|${row.bk_id}`));

  await appendRows(
    env,
    'attendance',
    unmarked.map((row) =>
      attendanceRow({
        sessionId: session.session_id,
        bkId: row.bk_id,
        status: 'absent',
        // Someone whose request was refused and who then did not come is not
        // a plain no-show: there was a decision, and it carries its reason.
        outcome: denied.has(row.bk_id) ? 'denied' : 'no_request',
        note: denied.get(row.bk_id) || '',
        source: 'karyakar_marked',
        actorId,
      })
    )
  );

  await setWindow(env, session, 'closed_manually');
  return { markedAbsent: unmarked.length };
}


// One delegate's own view: every session, what they are marked as, and how
// much of the absence allowance is gone. The browser is told the answer, never
// asked to work it out.
export async function standingFor(env, bkId) {
  const [sessionRows, latest, myRequests] = await Promise.all([
    readTab(env, 'sessions'),
    reconcile(env),
    requestsFor(env, bkId),
  ]);
  const today = todayLocal();

  const sessions = sessionRows
    .filter((row) => row.session_id)
    .sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)))
    .map((row) => {
      const record = latest.get(`${row.session_id}|${bkId}`) || null;
      const status = record ? record.status : 'not_checked_in';
      const ended = hasEnded(row);
      const request = requestState(myRequests, row.session_id);
      const started = Boolean(row.session_date) && today >= row.session_date;
      const live = request && request.state !== 'cancelled' ? request : null;

      return {
        ...publicSession(row),
        status,
        ended,
        daysAway: daysUntil(row.session_date, today),
        absenceOutcome: record ? record.absence_outcome : '',
        // Section 6: a denial states its reason, and the delegate is shown it.
        decisionNote: record ? record.decision_note : (live ? live.decision_note : ''),
        request: live
          ? { state: live.state, reason: live.reason, note: live.decision_note }
          : null,
        // Requests close when the session begins, and there is nothing to ask
        // about once you are already marked.
        canRequest: !started && !live && status === 'not_checked_in',
        canCheckIn: row.checkin_state === 'open' && !ended && status !== 'present',
      };
    });

  return {
    sessions,
    absencesUsed: sessions.filter((s) => s.status === 'absent').length,
    absencesAllowed: 1,
  };
}

// Whole days from today to a session, in Alabama. Negative once it has begun.
function daysUntil(startDate, today) {
  if (!startDate) return null;
  const toUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(startDate) - toUtc(today)) / 86400000);
}
