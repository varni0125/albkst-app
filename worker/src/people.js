// The delegate directory, one delegate's history, and the dashboard.
//
// All three answer questions a karyakar asks away from a session: who is this
// person, what have they missed, and what needs me today.

import { readTab } from './sheets.js';
import { pendingRequests } from './requests.js';
import { fullName } from './names.js';

const CENTER_ORDER = ['Birmingham', 'Dothan', 'Huntsville', 'Mobile', 'Montgomery'];
const isTrue = (value) => String(value).trim().toLowerCase() === 'true';

function rank(center) {
  const i = CENTER_ORDER.indexOf(center);
  return i < 0 ? CENTER_ORDER.length : i;
}

// One entry per delegate per session, most recently marked winning. Shared
// shape with the roster, kept here so the directory does not need a session.
function reconcile(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!row.session_id || !row.bk_id) continue;
    const key = `${row.session_id}|${row.bk_id}`;
    const held = latest.get(key);
    if (!held || String(row.marked_at) >= String(held.marked_at)) latest.set(key, row);
  }
  return latest;
}

// Only sessions that still exist, matching the roster and the delegate's own
// screen. Three places counted the same thing and one of them counted orphans.
function absencesByDelegate(latest, known) {
  const counts = new Map();
  for (const row of latest.values()) {
    if (row.status !== 'absent') continue;
    if (known && !known.has(row.session_id)) continue;
    counts.set(row.bk_id, (counts.get(row.bk_id) || 0) + 1);
  }
  return counts;
}

async function knownSessions(env) {
  const rows = await readTab(env, 'sessions');
  return new Set(rows.map((row) => row.session_id).filter(Boolean));
}

export async function directory(env) {
  const [delegates, attendance, known] = await Promise.all([
    readTab(env, 'delegates'),
    readTab(env, 'attendance'),
    knownSessions(env),
  ]);
  const counts = absencesByDelegate(reconcile(attendance), known);

  const people = delegates
    .filter((row) => row.bk_id && isTrue(row.active))
    .map((row) => ({
      bkId: row.bk_id,
      name: fullName(row.first_name, row.last_name),
      grade: row.grade,
      center: row.center,
      absencesUsed: counts.get(row.bk_id) || 0,
    }));

  const centers = [...new Set(people.map((p) => p.center))].sort(
    (a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b))
  );

  return {
    total: people.length,
    groups: centers.map((center) => ({
      center,
      members: people
        .filter((p) => p.center === center)
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  };
}

export async function delegateDetail(env, bkId) {
  const [delegates, attendance, sessions] = await Promise.all([
    readTab(env, 'delegates'),
    readTab(env, 'attendance'),
    readTab(env, 'sessions'),
  ]);

  const row = delegates.find((d) => d.bk_id === bkId && isTrue(d.active));
  if (!row) return null;

  const latest = reconcile(attendance);
  const history = sessions
    .filter((s) => s.session_id)
    .sort((a, b) => String(a.session_date).localeCompare(String(b.session_date)))
    .map((s) => {
      const record = latest.get(`${s.session_id}|${bkId}`) || null;
      return {
        sessionId: s.session_id,
        startDate: s.session_date,
        endDate: s.session_end_date,
        location: s.location,
        status: record ? record.status : 'not_checked_in',
        absenceOutcome: record ? record.absence_outcome : '',
        reason: record ? record.reason : '',
        decisionNote: record ? record.decision_note : '',
        source: record ? record.source : '',
        markedBy: record ? record.marked_by : '',
      };
    });

  return {
    bkId: row.bk_id,
    name: fullName(row.first_name, row.last_name),
    grade: row.grade,
    center: row.center,
    termGroup: row.term_group,
    notes: row.notes,
    absencesUsed: history.filter((h) => h.status === 'absent').length,
    absencesAllowed: 1,
    history,
  };
}

// What needs a karyakar today.
//
// Grades are not here because there are none yet; when scores exist this grows
// a "below 80%" section, which is the other half of section 8. Showing an
// empty grade section now would be a promise the app cannot keep.
export async function dashboard(env) {
  const [delegates, attendance, requests, known] = await Promise.all([
    readTab(env, 'delegates'),
    readTab(env, 'attendance'),
    pendingRequests(env),
    knownSessions(env),
  ]);

  const latest = reconcile(attendance);
  const counts = absencesByDelegate(latest, known);
  const nameOf = new Map(
    delegates
      .filter((row) => isTrue(row.active))
      .map((row) => [row.bk_id, fullName(row.first_name, row.last_name)])
  );

  const allowanceSpent = [...counts.entries()]
    .filter(([bkId]) => nameOf.has(bkId))
    .map(([bkId, used]) => ({
      bkId,
      name: nameOf.get(bkId),
      absencesUsed: used,
      // Two absences end participation, so the second one is not a warning.
      critical: used >= 2,
    }))
    .sort((a, b) => b.absencesUsed - a.absencesUsed || a.name.localeCompare(b.name));

  return {
    requests,
    allowanceSpent,
    counts: {
      requests: requests.length,
      allowanceSpent: allowanceSpent.length,
      atLimit: allowanceSpent.filter((p) => p.critical).length,
    },
  };
}
