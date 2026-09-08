// Sessions, the check-in window, and attendance.
//
// Attendance is an append-only ledger: every check-in and every karyakar mark
// adds a row and the most recent row for a delegate and session wins. That is
// what makes twenty-five simultaneous check-ins safe, and what makes an
// automatic absent mark reversible without losing the history.

import { readTab, appendRows, updateRow } from './sheets.js';

const CENTER_ORDER = ['Birmingham', 'Dothan', 'Huntsville', 'Mobile', 'Montgomery'];
const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

export const WINDOW_STATES = ['closed', 'open', 'closed_manually'];

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

  const centers = [...new Set(people.map((p) => p.center))].sort(
    (a, b) => CENTER_ORDER.indexOf(a) - CENTER_ORDER.indexOf(b)
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
  await updateRow(env, 'sessions', session._row, { checkin_state: state });
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

// Today in Alabama, not in UTC. A session that ended on the 13th must stop
// accepting check-ins at midnight there, not at seven in the evening.
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
  }).format(new Date());
}

function hasEnded(session) {
  const end = session.session_end_date || session.session_date;
  return Boolean(end) && todayLocal() > end;
}

// A delegate checking themselves in. Refused unless the window is open and the
// session has not already happened — both checked here, not in the browser.
export async function selfCheckin(env, session, bkId) {
  if (hasEnded(session)) {
    return { ok: false, error: 'That session is over.' };
  }
  if (session.checkin_state !== 'open') {
    return { ok: false, error: 'Check-in is not open for this session.' };
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
  const [delegates, latest] = await Promise.all([
    readTab(env, 'delegates'),
    reconcile(env),
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
        outcome: 'no_request',
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
  const [sessionRows, latest] = await Promise.all([
    readTab(env, 'sessions'),
    reconcile(env),
  ]);

  const sessions = sessionRows
    .filter((row) => row.session_id)
    .sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)))
    .map((row) => {
      const record = latest.get(`${row.session_id}|${bkId}`) || null;
      const status = record ? record.status : 'not_checked_in';
      const ended = hasEnded(row);
      return {
        ...publicSession(row),
        status,
        ended,
        absenceOutcome: record ? record.absence_outcome : '',
        // Section 6: a denial states its reason, and the delegate is shown it.
        decisionNote: record ? record.decision_note : '',
        canCheckIn: row.checkin_state === 'open' && !ended && status !== 'present',
      };
    });

  return {
    sessions,
    absencesUsed: sessions.filter((s) => s.status === 'absent').length,
    absencesAllowed: 1,
  };
}
