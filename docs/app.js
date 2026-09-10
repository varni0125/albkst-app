// BKST frontend.
//
// This file decides nothing about who you are, what you may see, or what
// anything counts for. It sends what you did to the Worker and renders the
// answer, including the Worker's own wording for every refusal.

const API = 'https://bkst-api.bkst.workers.dev';
const TOKEN_KEY = 'bkst.token';
const POLL_MS = 8000;
const SESSIONS_IN_A_YEAR = 6;

const views = {
  login: document.getElementById('view-login'),
  setpin: document.getElementById('view-setpin'),
  sessions: document.getElementById('view-sessions'),
  session: document.getElementById('view-session'),
  delegates: document.getElementById('view-delegates'),
  delegateDetail: document.getElementById('view-delegate-detail'),
  scores: document.getElementById('view-scores'),
  dashboard: document.getElementById('view-dashboard'),
  delegate: document.getElementById('view-delegate'),
  mySession: document.getElementById('view-my-session'),
  schedule: document.getElementById('view-schedule'),
  scheduleEdit: document.getElementById('view-schedule-edit'),
};
const message = document.getElementById('message');
const accountBar = document.getElementById('account-bar');
const tabBar = document.getElementById('tabs');

let account = null;
let pendingId = '';
let openSessionId = null;
let openPerson = null;
let pollTimer = null;
let messageTimer = null;
let qrTimer = null;
let qrBlob = null;
let lastSession = null;
let lastRoster = null;
let lastDirectory = null;
let lastStanding = null;
let lastPayload = {};  // per screen, so a poll that changes nothing touches nothing
let lastSessions = null;
let lastDashboard = null;
let lastSchedule = null;
let scheduleSessionId = null;
let openDay = 1;
let peopleView = 'delegates'; // or 'karyakars' or 'removed'
let lastRemoved = null;
let currentTab = null;
let previousStatus = new Map(); // bkId -> status, so only real changes animate
let shownTally = null;          // the number currently on screen, for counting up

// Tabler icons, inlined. No icon library, no emoji.
const svg = (paths) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICON = {
  eye: svg('<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>'),
  eyeOff: svg('<path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.7 8.7 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.3 9.3 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/>'),
  calendar: svg('<path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/>'),
  users: svg('<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>'),
  scores: svg('<path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v0a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 12l2 2l4 -4"/>'),
  attention: svg('<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>'),
  home: svg('<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/>'),
  programme: svg('<path d="M11.795 21h-6.795a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v4"/><path d="M18 18m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M15 3v4"/><path d="M7 3v4"/><path d="M3 11h16"/><path d="M18 16.496v1.504l1 1"/>'),
};

const TABS = {
  karyakar: [
    { key: 'sessions', label: 'Sessions', icon: ICON.calendar, open: () => showSessions() },
    { key: 'delegates', label: 'Delegates', icon: ICON.users, open: () => showDirectory() },
    { key: 'programme', label: 'Programme', icon: ICON.programme, open: () => showProgramme() },
    { key: 'scores', label: 'Scores', icon: ICON.scores, open: () => showScores() },
    { key: 'dashboard', label: 'Attention', icon: ICON.attention, open: () => showDashboard() },
  ],
  // The delegate side earns tabs now that there is a second thing to look at.
  delegate: [
    { key: 'today', label: 'Today', icon: ICON.home, open: () => showStanding() },
    { key: 'programme', label: 'Programme', icon: ICON.programme, open: () => showSchedule() },
  ],
};

/* ---------- plumbing ---------- */

function show(name) {
  // A dialog belongs to the screen that opened it.
  if (document.body.classList.contains('dialog-open')) closeScheduleForm();
  for (const [key, section] of Object.entries(views)) section.hidden = key !== name;
  const polling = ['session', 'delegate'];
  if (!polling.includes(name)) stopPolling();
  window.scrollTo(0, 0);
}

// A toast pinned to the viewport. In the page flow a confirmation could appear
// above a roster someone had scrolled well past, and go unread.
function say(text, tone = 'problem') {
  if (messageTimer) clearTimeout(messageTimer);
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
  if (!text) return;
  messageTimer = setTimeout(() => {
    message.hidden = true;
  }, tone === 'problem' ? 8000 : 4000);
}

const clearMessage = () => say('');

// A placeholder while a screen loads. Nothing to read, but the shape of the
// page arrives immediately instead of a blank panel.
function skeleton(container, { tall = false, lines = 6 } = {}) {
  container.textContent = '';
  const holder = document.createElement('div');
  holder.className = 'skeleton';
  for (let i = 0; i < lines; i++) {
    const line = document.createElement('div');
    line.className = `skeleton-line${tall && i === 0 ? ' tall' : ''}${i % 3 === 2 ? ' short' : ''}`;
    holder.append(line);
  }
  container.append(holder);
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function call(path, options = {}) {
  const token = readToken();
  let response;
  try {
    response = await fetch(API + path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    // Nothing was recorded. Say so plainly rather than leaving someone to
    // wonder whether their check-in landed.
    return {
      ok: false,
      status: 0,
      body: {
        error: navigator.onLine
          ? 'Could not reach the server. Nothing was saved. Try again.'
          : 'You are offline. Nothing was saved. Try again once you have signal.',
      },
    };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    // A response with no JSON body is still a failure worth reporting.
  }
  if (response.status === 401 && account) signOut('Your session ended. Sign in again.');
  return { ok: response.ok, status: response.status, body };
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing can refuse storage; the session still works until reload.
  }
}
function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clean up if storage was never available.
  }
}

// A scanned code arrives in the URL. Kept for this tab only, and the address
// bar is cleaned so it is not left in a share or a screenshot.
const scanned = (function readScan() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('s');
  const code = params.get('c');
  if (sessionId && code) {
    try {
      sessionStorage.setItem('bkst.scan', JSON.stringify({ sessionId, code }));
    } catch {
      // Storage can be refused; the value in memory still serves this visit.
    }
    history.replaceState(null, '', location.pathname);
    return { sessionId, code };
  }
  try {
    return JSON.parse(sessionStorage.getItem('bkst.scan') || 'null');
  } catch {
    return null;
  }
})();

const scanFor = (sessionId) =>
  scanned && scanned.sessionId === sessionId ? scanned.code : null;

/* ---------- dates ---------- */

function dateRange(startIso, endIso) {
  const start = parseIso(startIso);
  if (!start) return startIso || '';
  const end = parseIso(endIso);
  const month = start.toLocaleDateString('en-US', { month: 'short' });
  if (!end || end.getTime() === start.getTime()) return `${month} ${start.getDate()}`;
  const endMonth = end.toLocaleDateString('en-US', { month: 'short' });
  return month === endMonth
    ? `${month} ${start.getDate()}-${end.getDate()}`
    : `${month} ${start.getDate()} - ${endMonth} ${end.getDate()}`;
}

function parseIso(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function countdown(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return '';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 14) return `In ${days} days`;
  return `In ${Math.round(days / 7)} weeks`;
}

/* ---------- tabs ---------- */

function buildTabs(role) {
  const tabs = TABS[role] || [];
  tabBar.hidden = tabs.length === 0;
  document.body.classList.toggle('has-tabs', tabs.length > 0);
  tabBar.textContent = '';
  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.tab = tab.key;
    button.innerHTML =
      `<span class="tab-pill">${tab.icon}</span><span>${tab.label}</span>` +
      '<span class="tab-badge" hidden></span>';
    button.addEventListener('click', () => selectTab(tab.key));
    tabBar.append(button);
  }
}

function selectTab(key) {
  currentTab = key;
  for (const button of tabBar.querySelectorAll('button')) {
    if (button.dataset.tab === key) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const tab = (TABS[account?.role] || []).find((t) => t.key === key);
  if (tab) tab.open();
}

function setBadge(key, count) {
  const button = tabBar.querySelector(`button[data-tab="${key}"]`);
  if (!button) return;
  const badge = button.querySelector('.tab-badge');
  // Emptied as well as hidden. A badge with no number in it is a small red
  // dot, which is exactly the kind of thing that appears from nowhere.
  badge.textContent = count > 0 ? String(count) : '';
  badge.hidden = !(count > 0);
}

/* ---------- karyakar: sessions ---------- */

async function showSessions() {
  show('sessions');
  // What was last seen goes up straight away; the network refreshes it behind.
  // Waiting on a round trip before drawing anything is what made moving
  // between tabs feel slow.
  if (lastSessions) drawSessions(lastSessions);
  else skeleton(document.getElementById('session-list'), { tall: true, lines: 3 });

  const { ok, body } = await call('/sessions');
  if (!ok) return say(body.error || 'Could not load the sessions.');
  lastSessions = body.sessions;
  if (unchanged('sessions', body)) return;
  drawSessions(body.sessions);
}

function drawSessions(sessions) {
  const list = document.getElementById('session-list');
  list.textContent = '';
  for (const session of sessions) {
    const card = document.createElement('button');
    card.className = 'session-card';
    card.type = 'button';
    const state = session.checkinOpen
      ? 'Check-in open'
      : session.checkinState === 'closed_manually'
        ? 'Check-in closed'
        : 'Check-in not open yet';
    card.innerHTML =
      `<h2>${escape(dateRange(session.startDate, session.endDate))}</h2>` +
      `<p>${escape(session.location)} &middot; ${escape(state)}</p>`;
    card.addEventListener('click', () => openSession(session.id));
    list.append(card);
  }
}

async function openSession(sessionId) {
  openSessionId = sessionId;
  openPerson = null;
  previousStatus = new Map();
  shownTally = null;
  clearMessage();
  show('session');
  document.getElementById('session-tiles').textContent = '';
  skeleton(document.getElementById('roster'), { lines: 8 });
  await refreshSession();
  startPolling(refreshSession);
}

async function refreshSession() {
  const { ok, body } = await call('/sessions/' + openSessionId);
  if (!ok) return say(body.error || 'Could not load that session.');
  // Twenty-five rows were being destroyed and rebuilt every eight seconds
  // whether anything had changed or not, which is most of what made this feel
  // unsteady. Nothing changed means nothing is touched.
  if (unchanged('session', body)) return;
  renderSession(body.session, body.roster);
}

// True when this screen's data is exactly what was last drawn.
function unchanged(key, payload) {
  const signature = JSON.stringify(payload);
  if (lastPayload[key] === signature) return true;
  lastPayload[key] = signature;
  return false;
}

function renderSession(session, roster) {
  lastSession = session;
  lastRoster = roster;
  document.getElementById('session-title').textContent = dateRange(session.startDate, session.endDate);
  document.getElementById('session-where').textContent = session.location;

  const open = session.checkinOpen;
  document.getElementById('window-state').textContent = open
    ? 'Check-in is open.'
    : session.checkinState === 'closed_manually'
      ? 'Check-in is closed.'
      : 'Check-in has not been opened.';

  const toggle = document.getElementById('window-toggle');
  toggle.textContent = open ? 'Close check-in' : 'Open check-in';
  toggle.onclick = () => setWindow(open ? 'closed' : 'open');

  document.getElementById('window-hint').textContent = open
    ? 'Closing marks everyone who has not checked in as absent. You can change any of them afterwards.'
    : '';

  const panel = document.getElementById('qr-panel');
  panel.hidden = !open;
  if (!open) clearQr();

  renderTiles(roster);

  renderRoster(roster);
}

// Three numbers rather than a sentence. A karyakar reads these from across a
// room; "12 of 25 checked in" has to be walked up to.
function renderTiles(roster) {
  const waiting = roster.total - roster.present - roster.absent;
  const tiles = [
    { key: 'present', number: roster.present, label: 'Present', tone: 'good' },
    { key: 'absent', number: roster.absent, label: 'Absent', tone: 'bad' },
    { key: 'waiting', number: waiting, label: 'Not in yet', tone: '' },
  ];
  const holder = document.getElementById('session-tiles');
  holder.textContent = '';
  for (const tile of tiles) {
    const box = document.createElement('div');
    box.className = 'tile';
    if (tile.tone) box.dataset.tone = tile.tone;
    box.innerHTML =
      `<span class="tile-number" data-key="${tile.key}">${tile.number}</span>` +
      `<span class="tile-label">${tile.label}</span>`;
    holder.append(box);
  }
  countTo(holder.querySelector('[data-key="present"]'), roster.present);
}

// The present count climbs to its new value, so people arriving reads as
// movement rather than as a figure that silently differs each time you look.
function countTo(element, value) {
  const from = shownTally;
  shownTally = value;
  if (
    !element || from === null || from === value || Math.abs(value - from) > 8 ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return;
  }
  let current = from;
  const step = value > from ? 1 : -1;
  element.textContent = current;
  const tick = () => {
    current += step;
    element.textContent = current;
    if (current !== value) setTimeout(tick, 90);
  };
  tick();
}

// No photographs, and there never will be any.
function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Re-rendering the roster changes what is above a row, so the row you are
// looking at slides out from under your finger. Measure it before and after
// and put it back where it was. The article's locked camera rule, applied to
// a list rather than to footage.
function keepRowInPlace(bkId, render) {
  const find = () => document.querySelector(`.person[data-bk="${bkId}"]`);
  const before = find()?.getBoundingClientRect().top;
  render();
  const after = find()?.getBoundingClientRect().top;
  if (before !== undefined && after !== undefined && before !== after) {
    window.scrollBy(0, after - before);
  }
}

function renderRoster(roster) {
  const container = document.getElementById('roster');
  container.textContent = '';

  if (!roster.total) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No active delegates on the roster.';
    container.append(empty);
    return;
  }

  for (const group of roster.groups) {
    const section = document.createElement('div');
    section.className = 'center-group';
    const head = document.createElement('div');
    head.className = 'center-head';
    head.innerHTML = `<span>${escape(group.center)}</span><span>${group.present} of ${group.total}</span>`;
    section.append(head);
    const list = document.createElement('div');
    list.className = 'list';
    for (const person of group.members) list.append(personRow(person));
    section.append(list);
    container.append(section);
  }
}

function statusLabel(person) {
  if (person.status === 'present') return ['present', 'Present'];
  if (person.status === 'absent') {
    return person.absenceOutcome === 'approved' ? ['excused', 'Excused'] : ['absent', 'Absent'];
  }
  return ['not_checked_in', 'Not in yet'];
}

function personRow(person) {
  const wrap = document.createElement('div');
  wrap.className = 'person';
  wrap.dataset.bk = person.bkId;
  const [status, label] = statusLabel(person);
  const row = document.createElement('button');
  row.className = 'person-row';
  row.type = 'button';
  const used = person.absencesUsed ? ` &middot; ${person.absencesUsed} of 1 absence used` : '';
  const grade = person.grade ? `${escape(person.grade)}th` : '';
  const changed = previousStatus.has(person.bkId) && previousStatus.get(person.bkId) !== status;
  previousStatus.set(person.bkId, status);
  row.innerHTML =
    `<span class="initials">${escape(initialsOf(person.name))}</span>` +
    `<span class="person-name">${escape(person.name)}</span>` +
    `<span class="person-meta">${grade}${used}</span>` +
    `<span class="chip${changed ? ' just-changed' : ''}" data-status="${status}">${label}</span>`;
  row.addEventListener('click', () => {
    openPerson = openPerson === person.bkId ? null : person.bkId;
    // Redrawn from what is already loaded, so a tap does not wait on a read.
    keepRowInPlace(person.bkId, () => {
      if (lastSession && lastRoster) renderSession(lastSession, lastRoster);
      else refreshSession();
    });
  });
  wrap.append(row);
  if (openPerson === person.bkId) wrap.append(personActions(person));
  return wrap;
}

function personActions(person) {
  const panel = document.createElement('div');
  panel.className = 'person-actions';

  if (person.reason || person.decisionNote) {
    const note = document.createElement('p');
    note.textContent = [person.reason, person.decisionNote].filter(Boolean).join(' - ');
    panel.append(note);
  }

  const actions = document.createElement('div');
  actions.className = 'action-row';
  actions.append(
    actionButton('Present', 'good', () => mark(person, { status: 'present' })),
    actionButton('Excused', '', () => askReason(panel, person, 'approved')),
    actionButton('Absent', 'danger', () => askReason(panel, person, 'denied'))
  );
  panel.append(actions);
  return panel;
}

function actionButton(label, kind, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (kind) button.dataset.kind = kind;
  button.addEventListener('click', onClick);
  return button;
}

// Section 6: a denial must state a reason, because the delegate is shown it.
function askReason(panel, person, outcome) {
  const existing = panel.querySelector('textarea');
  if (existing) existing.remove();
  const box = document.createElement('textarea');
  box.rows = 2;
  box.placeholder =
    outcome === 'approved'
      ? 'Reason for excusing this absence'
      : 'Why this absence is not excused. The delegate sees this.';
  panel.append(box);

  const confirm = document.createElement('div');
  confirm.className = 'action-row';
  confirm.append(
    actionButton(outcome === 'approved' ? 'Excuse' : 'Mark absent', 'danger', () => {
      const text = box.value.trim();
      if (!text) {
        say(
          outcome === 'approved'
            ? 'Say why this absence is excused.'
            : 'A denied absence has to state a reason. The delegate is shown it.'
        );
        return;
      }
      mark(person, {
        status: 'absent',
        absenceOutcome: outcome,
        reason: outcome === 'approved' ? text : '',
        decisionNote: outcome === 'denied' ? text : '',
      });
    })
  );
  panel.append(confirm);
  box.focus();
}

// The row changes the instant it is tapped, and the Worker's answer replaces
// it when it lands. If the Worker refuses, the old state comes back and the
// refusal is shown, so an optimistic screen never quietly disagrees with what
// was actually recorded.
async function mark(person, entry) {
  clearMessage();
  const rollback = lastRoster;
  openPerson = null;
  if (lastRoster) {
    keepRowInPlace(person.bkId, () =>
      renderSession(lastSession, guessRoster(lastRoster, person, entry))
    );
  }

  const { ok, body } = await call(`/sessions/${openSessionId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ bkId: person.bkId, ...entry }),
  });

  if (!ok) {
    if (rollback) keepRowInPlace(person.bkId, () => renderSession(lastSession, rollback));
    return say(body.error || 'That mark did not save.');
  }
  say(`${person.name} marked.`, 'good');
  lastPayload.session = null;
  keepRowInPlace(person.bkId, () => renderSession(lastSession, body.roster));
}

// What the roster will look like once the Worker agrees. Counts are adjusted
// so the tally and the per-centre numbers move with the row.
function guessRoster(roster, person, entry) {
  const wasAbsent = person.status === 'absent';
  const nowAbsent = entry.status === 'absent';
  const delta = (nowAbsent ? 1 : 0) - (wasAbsent ? 1 : 0);

  const groups = roster.groups.map((group) => {
    const members = group.members.map((member) =>
      member.bkId === person.bkId
        ? {
            ...member,
            status: entry.status,
            absenceOutcome: nowAbsent ? entry.absenceOutcome || 'no_request' : '',
            reason: entry.reason || '',
            decisionNote: entry.decisionNote || '',
            absencesUsed: Math.max(0, member.absencesUsed + delta),
          }
        : member
    );
    return {
      ...group,
      members,
      present: members.filter((m) => m.status === 'present').length,
    };
  });

  const everyone = groups.flatMap((g) => g.members);
  return {
    ...roster,
    groups,
    present: everyone.filter((p) => p.status === 'present').length,
    absent: everyone.filter((p) => p.status === 'absent').length,
  };
}

async function setWindow(state) {
  clearMessage();
  const { ok, body } = await call(`/sessions/${openSessionId}/window`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
  if (!ok) return say(body.error || 'Could not change the check-in window.');
  if (state === 'open') {
    // Opening check-in and showing a code are one intention, and this happens
    // with twenty-five people waiting. Two taps is one too many.
    await refreshSession();
    await generateCode();
    return;
  }
  if (body.markedAbsent > 0) {
    say(
      `${body.markedAbsent} ${body.markedAbsent === 1 ? 'delegate was' : 'delegates were'} marked absent. Tap a name to change it.`,
      'notice'
    );
  }
  await refreshSession();
}

/* ---------- the check-in code, drawn as a QR ---------- */

function qrCanvas(text, scale = 10, quiet = 4) {
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const pixels = (size + quiet * 2) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext('2d');
  const styles = getComputedStyle(document.documentElement);
  context.fillStyle = styles.getPropertyValue('--color-qr-light').trim();
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = styles.getPropertyValue('--color-qr-dark').trim();
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) context.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return canvas;
}

// Safari ignores the download attribute, so the obvious approach does nothing
// on an iPhone. The share sheet offers both Save Image and Save to Files.
async function saveCode() {
  if (!qrBlob) return;
  const file = new File([qrBlob], `bkst-checkin-${openSessionId}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'BKST check-in code' });
      return;
    } catch (error) {
      if (error && error.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(qrBlob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function clearQr() {
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
  qrBlob = null;
  document.getElementById('qr-holder').hidden = true;
  document.getElementById('qr-generate').textContent = 'Generate check-in code';
}

async function generateCode() {
  clearMessage();
  const { ok, body } = await call(`/sessions/${openSessionId}/checkin-code`, { method: 'POST' });
  if (!ok) return say(body.error || 'Could not make a code.');

  const url = `${location.origin}${location.pathname}?s=${encodeURIComponent(openSessionId)}&c=${encodeURIComponent(body.code)}`;
  const canvas = qrCanvas(url);
  document.getElementById('qr-image').src = canvas.toDataURL('image/png');
  canvas.toBlob((blob) => {
    qrBlob = blob;
  }, 'image/png');
  document.getElementById('qr-holder').hidden = false;
  document.getElementById('qr-generate').textContent = 'New code';

  const expiresAt = Date.now() + body.secondsLeft * 1000;
  const countdownEl = document.getElementById('qr-countdown');
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    countdownEl.textContent = left ? `Expires in ${minutes}:${seconds}` : 'Expired. Generate a new code.';
    countdownEl.dataset.expired = left ? 'false' : 'true';
    if (!left) clearQr();
  };
  tick();
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(tick, 1000);
}

/* ---------- karyakar: the directory ---------- */

async function showDirectory() {
  show('delegates');
  if (lastDirectory) renderDirectory(document.getElementById('delegate-search').value);
  else skeleton(document.getElementById('delegate-list'), { lines: 8 });

  const { ok, body } = await call('/delegates');
  if (!ok) return say(body.error || 'Could not load the delegates.');
  lastDirectory = body;
  if (unchanged('delegates', body)) return;
  renderDirectory(document.getElementById('delegate-search').value);
}

function renderPeopleSwitch() {
  const holder = document.getElementById('people-switch');
  holder.textContent = '';
  const counts = {
    delegates: lastDirectory?.total || 0,
    karyakars: (lastDirectory?.karyakars || []).length,
  };
  const views = account?.admin ? ['delegates', 'karyakars', 'removed'] : ['delegates', 'karyakars'];
  for (const key of views) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent =
      key === 'delegates' ? 'Delegates' : key === 'karyakars' ? 'Karyakars' : 'Removed';
    if (peopleView === key) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      peopleView = key;
      renderDirectory(document.getElementById('delegate-search').value);
    });
    holder.append(button);
  }
  document.getElementById('delegates-count').textContent =
    peopleView === 'delegates'
      ? `${counts.delegates} delegates across five centres.`
      : peopleView === 'karyakars'
        ? `${counts.karyakars} ${counts.karyakars === 1 ? 'karyakar' : 'karyakars'}.`
        : 'Removed from the roster. Their history is kept.';

  // Adding is an admin's job, and only on a screen where it makes sense.
  const add = document.getElementById('roster-add');
  const canAdd = account?.admin && peopleView !== 'removed';
  add.hidden = !canAdd;
  if (canAdd) {
    add.textContent = peopleView === 'delegates' ? 'Add a delegate' : 'Add a karyakar';
    add.onclick = () => addPersonDialog(peopleView === 'delegates' ? 'delegate' : 'karyakar');
  }
}

function renderDirectory(filter = '') {
  const needle = filter.trim().toLowerCase();
  const list = document.getElementById('delegate-list');
  list.textContent = '';
  if (!lastDirectory) return;
  renderPeopleSwitch();

  // Two screens, not one mixed list: a roster and a staff list answer
  // different questions.
  if (peopleView === 'karyakars') return renderKaryakars(needle, list);
  if (peopleView === 'removed') return renderRemoved(needle, list);

  let shown = 0;
  for (const group of lastDirectory.groups) {
    const members = group.members.filter((m) => m.name.toLowerCase().includes(needle));
    if (!members.length) continue;
    shown += members.length;

    const head = document.createElement('div');
    head.className = 'center-head';
    head.innerHTML = `<span>${escape(group.center)}</span><span>${members.length}</span>`;
    list.append(head);

    const panel = document.createElement('div');
    panel.className = 'list';
    for (const person of members) {
      const row = document.createElement('button');
      row.className = 'person-link';
      row.type = 'button';
      const used = person.absencesUsed
        ? `<span class="chip" data-status="${person.absencesUsed >= 2 ? 'absent' : 'excused'}">${person.absencesUsed} of 1</span>`
        : '';
      row.innerHTML =
        `<span class="initials">${escape(initialsOf(person.name))}</span>` +
        `<span class="person-name">${escape(person.name)}</span>` +
        `<span class="person-meta">${person.grade ? escape(person.grade) + 'th' : ''}</span>${used}`;
      row.addEventListener('click', () => openDelegate(person.bkId));
      panel.append(row);
    }
    list.append(panel);
  }
  if (!shown) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nobody by that name.';
    list.append(empty);
  }
}

function renderKaryakars(needle, list) {
  const karyakars = (lastDirectory.karyakars || []).filter((k) =>
    k.name.toLowerCase().includes(needle)
  );
  if (!karyakars.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nobody by that name.';
    list.append(empty);
    return;
  }
  const panel = document.createElement('div');
  panel.className = 'list';
  for (const person of karyakars) {
    const row = document.createElement('button');
    row.className = 'person-link';
    row.type = 'button';
    row.innerHTML =
      `<span class="initials">${escape(initialsOf(person.name))}</span>` +
      `<span class="person-name">${escape(person.name)}</span>` +
      `<span class="person-meta">${escape(person.id)}</span>`;
    row.addEventListener('click', () => karyakarActions(person));
    panel.append(row);
  }
  list.append(panel);
}

async function renderRemoved(needle, list) {
  if (!lastRemoved) {
    const { ok, body } = await call('/roster/removed');
    if (!ok) return say(body.error || 'Could not load that.');
    lastRemoved = body;
  }
  const rows = [
    ...lastRemoved.delegates.map((d) => ({ ...d, kind: 'delegate' })),
    ...lastRemoved.karyakars.map((k) => ({ ...k, kind: 'karyakar' })),
  ].filter((r) => r.name.toLowerCase().includes(needle));

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nobody has been removed.';
    list.append(empty);
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'list';
  for (const person of rows) {
    const row = document.createElement('button');
    row.className = 'person-link';
    row.type = 'button';
    row.innerHTML =
      `<span class="initials">${escape(initialsOf(person.name))}</span>` +
      `<span class="person-name">${escape(person.name)}</span>` +
      `<span class="person-meta">${escape(person.id)}</span>`;
    row.addEventListener('click', () => confirmActive(person, true));
    panel.append(row);
  }
  list.append(panel);
}

// Removing and bringing back share a dialog, because they are the same
// decision seen from either side.
function confirmActive(person, bringBack) {
  openDialog((panel) => {
    panel.innerHTML =
      `<h2>${escape(person.name)}</h2>` +
      `<p class="lede">${person.kind === 'karyakar' ? 'Karyakar' : 'Delegate'} &middot; ${escape(person.id)}</p>` +
      `<p class="hint">${
        bringBack
          ? 'They go back on the roster and can sign in again.'
          : 'They come off every roster and cannot sign in. Their attendance stays on record, and you can bring them back.'
      }</p>`;

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';

    const go = document.createElement('button');
    go.type = 'button';
    if (!bringBack) go.dataset.kind = 'danger';
    go.textContent = bringBack ? 'Bring back' : 'Remove';
    go.addEventListener('click', async () => {
      const { ok, body } = await call('/roster/active', {
        method: 'POST',
        body: JSON.stringify({ kind: person.kind, id: person.id, active: bringBack }),
      });
      closeScheduleForm();
      say(ok ? body.message : body.error || 'That did not work.', ok ? 'good' : 'problem');
      if (ok) {
        lastRemoved = null;
        lastDirectory = null;
        lastPayload.delegates = null;
        showDirectory();
      }
    });
    actions.append(go);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeScheduleForm);
    actions.append(cancel);
    panel.append(actions);
  });
}

function addPersonDialog(kind) {
  openDialog((panel) => {
    const field = (label, id, placeholder) =>
      `<div class="field"><label for="${id}">${label}</label>` +
      `<input id="${id}" type="text" placeholder="${placeholder}" autocomplete="off" /></div>`;

    panel.innerHTML =
      `<h2>Add a ${kind}</h2>` +
      (kind === 'delegate'
        ? field('BK ID', 'ap-id', '18966') +
          `<div class="pair">${field('First name', 'ap-first', 'Dhruv')}${field('Last name', 'ap-last', 'Patel')}</div>` +
          '<div class="pair">' +
          '<div class="field"><label for="ap-grade">Grade</label><select id="ap-grade">' +
          ['9', '10', '11', '12'].map((g) => `<option value="${g}">${g}th</option>`).join('') +
          '</select></div>' +
          '<div class="field"><label for="ap-center">Centre</label><select id="ap-center">' +
          ['Birmingham', 'Dothan', 'Huntsville', 'Mobile', 'Montgomery']
            .map((c) => `<option value="${c}">${c}</option>`).join('') +
          '</select></div></div>'
        : field('Karyakar ID', 'ap-id', 'K003') +
          `<div class="pair">${field('First name', 'ap-first', 'Veer')}${field('Last name', 'ap-last', 'Patel')}</div>` +
          '<p class="hint">They choose their own PIN the first time they sign in.</p>');

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = `Add ${kind}`;
    save.addEventListener('click', async () => {
      const value = (id) => document.getElementById(id)?.value.trim() || '';
      const body =
        kind === 'delegate'
          ? {
              bkId: value('ap-id'),
              firstName: value('ap-first'),
              lastName: value('ap-last'),
              grade: value('ap-grade'),
              center: value('ap-center'),
            }
          : {
              karyakarId: value('ap-id'),
              firstName: value('ap-first'),
              lastName: value('ap-last'),
            };
      const result = await call(`/roster/${kind}`, { method: 'POST', body: JSON.stringify(body) });
      if (!result.ok) return say(result.body.error || 'That did not save.');
      closeScheduleForm();
      say(result.body.message, 'good');
      lastDirectory = null;
      lastPayload.delegates = null;
      showDirectory();
    });
    panel.append(save);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    actions.style.gridTemplateColumns = 'minmax(0, 1fr)';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeScheduleForm);
    actions.append(cancel);
    panel.append(actions);

    document.getElementById('ap-id')?.focus();
  });
}

// A karyakar has no attendance to show, so there is no detail screen worth
// opening: the only thing anyone needs here is the reset.
function karyakarActions(person) {
  openDialog((panel) => {
    panel.innerHTML =
      `<h2>${escape(person.name)}</h2>` +
      `<p class="lede">Karyakar &middot; ${escape(person.id)}</p>` +
      (account?.admin
        ? '<p class="hint">Resetting clears their PIN. They choose a new one the ' +
          'next time they sign in, and it is logged against your name.</p>'
        : '<p class="hint">Only an admin karyakar can reset another karyakar\'s PIN.</p>');

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';

    // Only an admin may reset another karyakar. The Worker refuses it either
    // way; this stops offering a button that would only be turned down.
    if (account?.admin) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.dataset.kind = 'danger';
      reset.textContent = 'Reset PIN';
      reset.addEventListener('click', async () => {
        const { ok, body } = await call('/auth/reset-pin', {
          method: 'POST',
          body: JSON.stringify({ id: person.id }),
        });
        closeScheduleForm();
        say(ok ? body.message : body.error || 'Could not reset that PIN.', ok ? 'good' : 'problem');
      });
      actions.append(reset);
    }

    if (account?.admin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () =>
        confirmActive({ ...person, kind: 'karyakar' }, false)
      );
      actions.append(remove);
    } else {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', closeScheduleForm);
      actions.append(cancel);
    }

    panel.append(actions);
  });
}

async function openDelegate(bkId) {
  const { ok, body } = await call('/delegates/' + encodeURIComponent(bkId));
  if (!ok) return say(body.error || 'Could not load that delegate.');
  show('delegateDetail');

  document.getElementById('detail-name').textContent = body.name;
  document.getElementById('detail-meta').textContent =
    [body.grade ? body.grade + 'th grade' : '', body.center, body.bkId].filter(Boolean).join(' · ');

  const allowance = document.getElementById('detail-allowance');
  allowance.textContent = `${body.absencesUsed} of ${body.absencesAllowed} absence used`;
  allowance.dataset.spent = body.absencesUsed > 0 ? 'true' : 'false';

  const historyHolder = document.getElementById('detail-history');
  historyHolder.textContent = '';
  const history = document.createElement('div');
  history.className = 'list';
  historyHolder.append(history);
  for (const record of body.history) {
    const [status, label] = statusLabel(record);
    const item = document.createElement('div');
    item.className = 'record';
    item.innerHTML =
      '<div class="record-head">' +
      `<h2>${escape(dateRange(record.startDate, record.endDate))}</h2>` +
      `<span class="chip" data-status="${status}">${label}</span>` +
      '</div>' +
      `<p>${escape(record.location)}</p>`;
    const note = [record.reason, record.decisionNote].filter(Boolean).join(' - ');
    if (note) {
      const p = document.createElement('p');
      p.textContent = note;
      item.append(p);
    }
    history.append(item);
  }

  const removeHolder = document.getElementById('detail-reset').parentElement;
  const existing = removeHolder.querySelector('#detail-remove');
  if (existing) existing.remove();
  if (account?.admin) {
    const remove = document.createElement('button');
    remove.className = 'linkish';
    remove.id = 'detail-remove';
    remove.type = 'button';
    remove.textContent = 'Remove from roster';
    remove.addEventListener('click', () =>
      confirmActive({ id: body.bkId, name: body.name, kind: 'delegate' }, false)
    );
    document.getElementById('detail-reset').after(remove);
  }

  const reset = document.getElementById('detail-reset');
  reset.onclick = async () => {
    const result = await call('/auth/reset-pin', {
      method: 'POST',
      body: JSON.stringify({ id: body.bkId }),
    });
    say(
      result.ok ? result.body.message : result.body.error || 'Could not reset that PIN.',
      result.ok ? 'good' : 'problem'
    );
  };
}

/* ---------- karyakar: scores ---------- */

async function showScores() {
  show('scores');
  skeleton(document.getElementById('score-list'), { lines: 3 });
  const { ok, body } = await call('/sessions');
  if (!ok) return say(body.error || 'Could not load the sessions.');

  const holder = document.getElementById('score-list');
  holder.textContent = '';
  const list = document.createElement('div');
  list.className = 'list';
  holder.append(list);
  for (const session of body.sessions) {
    const item = document.createElement('div');
    item.className = 'record';
    item.innerHTML =
      '<div class="record-head">' +
      `<h2>${escape(dateRange(session.startDate, session.endDate))}</h2>` +
      '<span class="chip" data-status="not_checked_in">Not entered</span>' +
      '</div>' +
      `<p>${escape(session.location)}</p>`;
    list.append(item);
  }
  const note = document.createElement('p');
  note.className = 'empty';
  holder.append(note);
  note.textContent =
    'Score entry is still being built. When it is, each session shows the points ' +
    'entered and the grade computed from them. Session one carries no quiz and no ' +
    'homework, so it will have no grade at all and will not count towards the year.';
}

/* ---------- karyakar: needs attention ---------- */

async function showDashboard() {
  show('dashboard');
  if (lastDashboard) renderDashboard(lastDashboard);
  else skeleton(document.getElementById('dashboard-body'), { lines: 4 });

  const { ok, body } = await call('/dashboard');
  if (!ok) return say(body.error || 'Could not load the dashboard.');
  lastDashboard = body;
  if (unchanged('dashboard', body)) return;
  renderDashboard(body);
}

function renderDashboard(data) {
  setBadge('dashboard', data.counts.requests);
  document.getElementById('dashboard-lede').textContent =
    data.counts.requests || data.counts.allowanceSpent
      ? 'Requests waiting on you, and delegates who have spent their allowance.'
      : 'Nothing needs you right now.';

  const body = document.getElementById('dashboard-body');
  body.textContent = '';

  if (data.requests.length) {
    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = `<span>Absence requests</span><span>${data.requests.length}</span>`;
    body.append(head);
    for (const request of data.requests) body.append(requestCard(request));
  }

  if (data.allowanceSpent.length) {
    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = `<span>Absences used</span><span>${data.allowanceSpent.length}</span>`;
    body.append(head);
    for (const person of data.allowanceSpent) {
      const row = document.createElement('button');
      row.className = 'person-link';
      row.type = 'button';
      row.innerHTML =
        `<span class="initials">${escape(initialsOf(person.name))}</span>` +
        `<span class="person-name">${escape(person.name)}</span>` +
        `<span class="chip" data-status="${person.critical ? 'absent' : 'excused'}">${person.absencesUsed} of 1</span>`;
      row.addEventListener('click', () => openDelegate(person.bkId));
      body.append(row);
    }
  }

  if (!data.requests.length && !data.allowanceSpent.length) {
    // Says what would be here, so an empty screen reads as working rather
    // than as broken.
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      'Absence requests appear here when a delegate sends one, and anyone who ' +
      'uses an absence stays listed for the rest of the year. Session grades ' +
      'below 80 per cent will join them once scores are being entered.';
    body.append(empty);
  }
}

function requestCard(request) {
  const card = document.createElement('div');
  card.className = 'request-card';
  card.innerHTML =
    `<h2>${escape(request.name)}</h2>` +
    `<p class="when">${escape(dateRange(request.sessionStart, request.sessionEnd))} &middot; ${escape(request.location)}</p>` +
    `<blockquote>${escape(request.reason)}</blockquote>`;

  const box = document.createElement('textarea');
  box.rows = 2;
  box.placeholder = 'A note. Required to deny, since the delegate is shown it.';
  card.append(box);

  const actions = document.createElement('div');
  actions.className = 'action-row';
  actions.append(
    actionButton('Approve', 'good', () => decide(request, 'approved', box.value)),
    actionButton('Deny', 'danger', () => {
      if (!box.value.trim()) {
        say('A denied request has to state a reason. The delegate is shown it.');
        box.focus();
        return;
      }
      decide(request, 'denied', box.value);
    })
  );
  card.append(actions);
  return card;
}

async function decide(request, decision, note) {
  clearMessage();
  const { ok, body } = await call(`/requests/${request.requestId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });
  if (!ok) return say(body.error || 'That decision did not save.');
  say(`${request.name}: ${decision === 'approved' ? 'excused' : 'denied'}.`, 'good');
  lastDashboard = body.dashboard;
  lastPayload.dashboard = null;
  renderDashboard(body.dashboard);
}

/* ---------- delegate ---------- */

async function showStanding() {
  show('delegate');
  if (!lastStanding) skeleton(document.getElementById('session-lines'), { lines: 4 });
  await refreshStanding();
  startPolling(refreshStanding);
}

async function refreshStanding() {
  const { ok, body } = await call('/me/standing');
  if (!ok) return say(body.error || 'Could not load your sessions.');
  lastStanding = body;
  if (unchanged('standing', body)) return;
  renderStanding(body);
}

function slotStatus(session) {
  if (session.status === 'present') return 'present';
  if (session.status === 'absent') {
    return session.absenceOutcome === 'approved' ? 'excused' : 'absent';
  }
  return 'upcoming';
}

function statusWords(session) {
  if (session.status === 'present') return 'Present';
  if (session.status === 'absent') {
    return session.absenceOutcome === 'approved' ? 'Excused' : 'Absent';
  }
  if (session.request && session.request.state === 'pending') return 'Request sent';
  return session.ended ? 'Not recorded' : 'Not yet';
}

function renderStanding(standing) {
  const allowance = document.getElementById('allowance');
  allowance.textContent = `${standing.absencesUsed} of ${standing.absencesAllowed} absence used`;
  allowance.dataset.spent = standing.absencesUsed > 0 ? 'true' : 'false';

  // A session with its window open is the one happening now, whatever the
  // calendar says. Only when nothing is open does the next date win.
  const next =
    standing.sessions.find((s) => !s.ended && s.checkinOpen) ||
    standing.sessions.find((s) => !s.ended);

  const card = document.getElementById('next-card');
  card.hidden = !next;
  if (next) {
    document.getElementById('next-when').textContent = dateRange(next.startDate, next.endDate);
    document.getElementById('next-countdown').textContent = countdown(next.daysAway);
    document.getElementById('next-where').textContent = next.location;

    const code = scanFor(next.id);
    const button = document.getElementById('checkin');
    button.hidden = !next.canCheckIn || !code;
    button.onclick = () => checkIn(next.id, code);
    document.getElementById('next-scan').hidden = !next.canCheckIn || Boolean(code);

    const hint = document.getElementById('next-hint');
    if (next.status === 'present') hint.textContent = 'You are checked in.';
    else if (next.status === 'absent') {
      hint.textContent =
        next.absenceOutcome === 'approved'
          ? 'This session is excused.'
          : 'You are marked absent for this session.';
    } else hint.textContent = '';

    // Section 6: a denial states its reason to the delegate. It belongs here,
    // where they already are, not behind a tap they have no reason to make.
    const reason = document.getElementById('next-reason');
    reason.textContent = next.decisionNote || '';
    reason.hidden = !next.decisionNote;

    renderRequest(next);
  }

  renderSlots(standing.sessions);
  renderSessionLines(standing.sessions);
}

function renderRequest(session) {
  const holder = document.getElementById('next-request');
  holder.textContent = '';
  // Only a panel once there is something in it: the class carries a top
  // border, and an empty one draws a line across the card for no reason.
  holder.className = '';

  if (session.request && session.request.state === 'pending') {
    holder.className = 'request-state';
    holder.innerHTML =
      '<p>Absence requested. Waiting on a karyakar.</p>' +
      `<blockquote>${escape(session.request.reason)}</blockquote>`;
    const cancel = document.createElement('button');
    cancel.className = 'linkish';
    cancel.type = 'button';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => cancelRequest(session.id));
    holder.append(cancel);
    return;
  }

  if (!session.canRequest) return;

  holder.className = 'request-state';
  const open = document.createElement('button');
  open.className = 'linkish';
  open.type = 'button';
  open.textContent = 'Request an absence';
  open.addEventListener('click', () => {
    holder.textContent = '';
    const box = document.createElement('textarea');
    box.rows = 3;
    box.placeholder = 'Why you cannot come. A karyakar reads this.';
    holder.append(box);
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = 'Send request';
    send.addEventListener('click', () => sendRequest(session.id, box.value));
    holder.append(send);
    box.focus();
  });
  holder.append(open);
}

async function sendRequest(sessionId, reason) {
  clearMessage();
  if (!reason.trim()) return say('Say why you cannot come.');
  const { ok, body } = await call(`/sessions/${sessionId}/absence-request`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  if (!ok) return say(body.error || 'That request did not send.');
  say('Request sent. A karyakar will decide.', 'good');
  lastStanding = body.standing;
  renderStanding(body.standing);
}

async function cancelRequest(sessionId) {
  clearMessage();
  const { ok, body } = await call(`/sessions/${sessionId}/cancel-request`, { method: 'POST' });
  if (!ok) return say(body.error || 'Could not cancel that.');
  say('Request cancelled.', 'notice');
  lastStanding = body.standing;
  renderStanding(body.standing);
}

function renderSlots(sessions) {
  const row = document.getElementById('slots');
  row.textContent = '';
  for (let i = 0; i < SESSIONS_IN_A_YEAR; i++) {
    const session = sessions[i];
    const slot = document.createElement('div');
    slot.className = 'slot';
    if (session) {
      slot.dataset.status = slotStatus(session);
      slot.textContent = dateRange(session.startDate, session.endDate);
    } else {
      slot.dataset.status = 'unscheduled';
      slot.textContent = 'Spring';
    }
    row.append(slot);
  }
}

function renderSessionLines(sessions) {
  const holder = document.getElementById('session-lines');
  holder.textContent = '';
  const list = document.createElement('div');
  list.className = 'list';
  holder.append(list);
  for (const session of sessions) {
    const status = slotStatus(session);
    const line = document.createElement('button');
    line.className = 'session-line-link';
    line.type = 'button';
    line.innerHTML =
      '<div class="session-line-head">' +
      `<h2>${escape(dateRange(session.startDate, session.endDate))}</h2>` +
      `<span class="chip" data-status="${status === 'upcoming' ? 'not_checked_in' : status}">${escape(statusWords(session))}</span>` +
      '</div>' +
      `<p>${escape(session.location)}</p>` +
      (session.decisionNote
        ? `<div class="decision">${escape(session.decisionNote)}</div>`
        : '');
    line.addEventListener('click', () => openMySession(session.id));
    list.append(line);
  }
}

function openMySession(sessionId) {
  const session = (lastStanding?.sessions || []).find((s) => s.id === sessionId);
  if (!session) return;
  show('mySession');

  document.getElementById('my-session-title').textContent = dateRange(session.startDate, session.endDate);
  document.getElementById('my-session-where').textContent =
    [session.location, countdown(session.daysAway)].filter(Boolean).join(' · ');

  const body = document.getElementById('my-session-body');
  body.textContent = '';

  const status = slotStatus(session);
  const record = document.createElement('div');
  record.className = 'record';
  record.innerHTML =
    '<div class="record-head">' +
    '<h2>You are marked</h2>' +
    `<span class="chip" data-status="${status === 'upcoming' ? 'not_checked_in' : status}">${escape(statusWords(session))}</span>` +
    '</div>';
  body.append(record);

  // Section 6: a denial states its reason, and the delegate is shown it.
  if (session.decisionNote) {
    const note = document.createElement('div');
    note.className = 'session-line';
    note.innerHTML = `<div class="decision">${escape(session.decisionNote)}</div>`;
    body.append(note);
  }

  if (session.request && session.request.state === 'pending') {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = `Absence requested: "${session.request.reason}". Waiting on a karyakar.`;
    body.append(p);

    const cancel = document.createElement('button');
    cancel.className = 'linkish';
    cancel.type = 'button';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', async () => {
      await cancelRequest(session.id);
      openMySession(session.id);
    });
    body.append(cancel);
  } else if (session.request) {
    // Decided. Say so, rather than leaving the absent option unexplained.
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent =
      session.request.state === 'approved'
        ? 'Your absence request was approved.'
        : 'Your absence request was not approved. Ask a karyakar if that needs revisiting.';
    body.append(p);
  } else if (session.canRequest) {
    // Any session can be requested from here, not just whichever one is next.
    const holder = document.createElement('div');
    holder.className = 'request-state';
    const open = document.createElement('button');
    open.className = 'linkish';
    open.type = 'button';
    open.textContent = 'Request an absence';
    open.addEventListener('click', () => {
      holder.textContent = '';
      const box = document.createElement('textarea');
      box.rows = 3;
      box.placeholder = 'Why you cannot come. A karyakar reads this.';
      holder.append(box);
      const send = document.createElement('button');
      send.type = 'button';
      send.textContent = 'Send request';
      send.addEventListener('click', async () => {
        await sendRequest(session.id, box.value);
        openMySession(session.id);
      });
      holder.append(send);
      box.focus();
    });
    holder.append(open);
    body.append(holder);
  } else if (!session.ended && session.status === 'not_checked_in') {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'This session has started, so a request can no longer be sent. Ask a karyakar.';
    body.append(p);
  }
}

async function checkIn(sessionId, code) {
  clearMessage();
  const button = document.getElementById('checkin');
  button.disabled = true;
  const { ok, body } = await call(`/sessions/${sessionId}/checkin`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  button.disabled = false;
  if (!ok) {
    say(body.error || 'That did not save. Try again.');
    await refreshStanding();
    return;
  }
  say('You are checked in.', 'good');
  await refreshStanding();
}

/* ---------- polling ---------- */

function startPolling(refresher) {
  stopPolling();
  pollTimer = setInterval(() => {
    // Not while a karyakar is mid-decision on a name.
    if (!openPerson && !document.hidden) refresher();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}


/* ---------- the programme ---------- */

// Which session's programme to show: the one with check-in open, else the next
// one that has not finished. Same rule as the delegate's own card.
function programmeSession(sessions) {
  return (
    sessions.find((s) => !s.ended && s.checkinOpen) ||
    sessions.find((s) => !s.ended) ||
    sessions[sessions.length - 1]
  );
}

async function showSchedule() {
  show('schedule');
  if (!lastStanding) {
    const standing = await call('/me/standing');
    if (standing.ok) lastStanding = standing.body;
  }
  const session = programmeSession(lastStanding?.sessions || []);
  if (!session) return say('No sessions are scheduled yet.');

  document.getElementById('schedule-where').textContent =
    `${dateRange(session.startDate, session.endDate)} · ${session.location}`;

  if (lastSchedule && scheduleSessionId === session.id) drawSchedule(lastSchedule, false);
  else skeleton(document.getElementById('schedule-body'), { lines: 6 });

  const { ok, body } = await call(`/sessions/${session.id}/schedule`);
  if (!ok) return say(body.error || 'Could not load the programme.');
  scheduleSessionId = session.id;
  lastSchedule = body;
  drawSchedule(body, false);
}

function dayTabs(schedule, holder, onPick) {
  holder.textContent = '';
  for (const day of schedule.days) {
    const button = document.createElement('button');
    button.type = 'button';
    // Friday, not Friday Sep 11: three of these have to fit across a phone.
    button.textContent = (day.label.split(',')[0] || `Day ${day.day}`);
    if (day.day === openDay) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      openDay = day.day;
      onPick();
    });
    holder.append(button);
  }
}

function drawSchedule(schedule, editable) {
  const tabs = document.getElementById(editable ? 'edit-day-tabs' : 'day-tabs');
  dayTabs(schedule, tabs, () => drawSchedule(schedule, editable));

  const holder = document.getElementById(editable ? 'schedule-edit-body' : 'schedule-body');
  holder.textContent = '';
  const body = document.createElement('div');
  body.className = 'list';
  holder.append(body);

  const day = schedule.days.find((d) => d.day === openDay) || schedule.days[0];
  if (!day || !day.items.length) {
    holder.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = editable
      ? 'Nothing on this day yet. Add the first item below.'
      : 'Nothing listed for this day yet.';
    holder.append(empty);
    return;
  }

  for (const item of day.items) {
    const row = document.createElement('div');
    row.className = 'slot-row';
    row.dataset.meal = String(item.isMeal);

    const time = document.createElement('div');
    time.className = 'slot-time';
    time.textContent = item.time;
    row.append(time);

    const what = document.createElement('div');
    what.className = 'slot-what';
    const detail = [
      item.presenter,
      item.location,
      item.duration ? item.duration : '',
    ].filter(Boolean).join(' · ');
    what.innerHTML =
      `<h2>${escape(item.item)}</h2>` + (detail ? `<p>${escape(detail)}</p>` : '');
    if (item.note) {
      const note = document.createElement('p');
      note.className = item.isMeal ? 'menu' : '';
      note.textContent = item.note;
      what.append(note);
    }
    if (editable) {
      const edit = document.createElement('button');
      edit.className = 'slot-edit';
      edit.type = 'button';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => scheduleForm(item));
      what.append(edit);

      const push = document.createElement('button');
      push.className = 'slot-edit';
      push.type = 'button';
      push.textContent = 'Push back';
      push.addEventListener('click', () => pushBackDialog(item));
      what.append(push);
    }
    row.append(what);
    body.append(row);
  }
}

/* ---------- karyakar: changing the programme ---------- */

// The Programme tab. Opens on whichever session is next, and lets a karyakar
// switch to another so October can be prepared in September.
async function showProgramme() {
  show('scheduleEdit');
  if (!lastSessions) {
    const list = await call('/sessions');
    if (!list.ok) return say(list.body.error || 'Could not load the sessions.');
    lastSessions = list.body.sessions;
  }
  const today = new Date().toISOString().slice(0, 10);
  const chosen =
    lastSessions.find((s) => s.id === scheduleSessionId) ||
    lastSessions.find((s) => s.checkinOpen) ||
    lastSessions.find((s) => (s.endDate || s.startDate) >= today) ||
    lastSessions[lastSessions.length - 1];
  if (!chosen) return say('No sessions are scheduled yet.');
  await openScheduleEditor(chosen);
}

async function openScheduleEditor(session) {
  scheduleSessionId = session.id;
  clearMessage();
  show('scheduleEdit');

  const where = document.getElementById('schedule-edit-where');
  where.textContent = '';
  const picker = document.createElement('div');
  picker.className = 'day-tabs session-picker';
  for (const option of lastSessions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = dateRange(option.startDate, option.endDate);
    if (option.id === session.id) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      openDay = 1;
      openScheduleEditor(option);
    });
    picker.append(button);
  }
  where.append(picker);
  const at = document.createElement('p');
  at.className = 'lede';
  at.textContent = session.location;
  where.append(at);

  skeleton(document.getElementById('schedule-edit-body'), { lines: 6 });
  const { ok, body } = await call(`/sessions/${session.id}/schedule`);
  if (!ok) return say(body.error || 'Could not load the programme.');
  lastSchedule = body;
  drawSchedule(body, true);
}

// One dialog mechanism, so everything that interrupts looks the same.
function openDialog(build) {
  const holder = document.getElementById('schedule-form');
  holder.textContent = '';
  holder.className = 'scrim';
  document.body.classList.add('dialog-open');

  // Assigned, not added. addEventListener on a element that outlives the
  // dialog stacks a new handler every time one is opened.
  holder.onclick = (event) => {
    if (event.target === holder) closeScheduleForm();
  };

  const panel = document.createElement('div');
  panel.className = 'schedule-form';

  // In the document before it is built. Otherwise anything the builder looks
  // up by id finds nothing, and calling focus on nothing takes the whole
  // script down with it.
  holder.append(panel);
  build(panel);
  return panel;
}

function closeScheduleForm() {
  const holder = document.getElementById('schedule-form');
  holder.textContent = '';
  // The class as well as the contents. Emptying it alone left a full screen
  // scrim in place: invisible, but covering the page, greying it out and
  // swallowing every tap.
  holder.className = '';
  document.body.classList.remove('dialog-open');
}

function scheduleForm(item) {
  const holder = document.getElementById('schedule-form');
  holder.textContent = '';
  holder.className = 'scrim';
  document.body.classList.add('dialog-open');

  // Tapping the darkened page behind closes it, the way a sheet does.
  holder.onclick = (event) => {
    if (event.target === holder) closeScheduleForm();
  };

  const form = document.createElement('div');
  form.className = 'schedule-form';

  const field = (label, id, value, placeholder) =>
    `<div class="field"><label for="${id}">${label}</label>` +
    `<input id="${id}" type="text" value="${escape(value || '')}" placeholder="${placeholder || ''}" /></div>`;

  // A real time input: the phone shows its own picker, which is twelve hour
  // on an American iPhone, and hands back 24 hour, which is what sorts.
  const timeField = (label, id, value) =>
    `<div class="field"><label for="${id}">${label}</label>` +
    `<input id="${id}" type="time" value="${escape(value || '')}" /></div>`;

  form.innerHTML =
    `<h2>${item ? 'Edit this item' : 'Add an item'}</h2>` +
    `<div class="pair">${timeField('Start', 'sf-start', item?.rawTime)}${timeField('End', 'sf-end', item?.rawEndTime)}</div>` +
    field('What', 'sf-item', item?.item, 'Dinner') +
    `<div class="pair">${field('Presenter', 'sf-presenter', item?.presenter, '')}${field('Location', 'sf-location', item?.location, 'Main Hall')}</div>` +
    `<label class="checkline"><input type="checkbox" id="sf-meal" ${item?.isMeal ? 'checked' : ''} /> This is a meal</label>` +
    `<div class="field" id="sf-menu-field"${item?.isMeal ? '' : ' hidden'}>` +
    '<label for="sf-menu">Menu</label>' +
    `<textarea id="sf-menu" rows="2" placeholder="Rotli, shaak, dal bhaat, salad">${escape(item?.note || '')}</textarea>` +
    '</div>';

  // The menu is a thing about meals, so it appears when something is one.
  form.querySelector('#sf-meal').addEventListener('change', (event) => {
    form.querySelector('#sf-menu-field').hidden = !event.target.checked;
  });

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = item ? 'Save changes' : 'Add to the programme';
  save.addEventListener('click', () => saveScheduleItem(item));
  form.append(save);

  // Two pills side by side, so Remove is never hit reaching for Cancel.
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  if (item) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.kind = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => saveScheduleItem(item, true));
    actions.append(remove);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeScheduleForm);
  actions.append(cancel);

  if (!item) actions.style.gridTemplateColumns = 'minmax(0, 1fr)';
  form.append(actions);

  holder.append(form);
  document.getElementById('sf-item')?.focus();
}

function minutesOf(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function saveScheduleItem(item, remove) {
  clearMessage();
  const id = item?.id;
  const value = (name) => document.getElementById(name)?.value.trim() || '';
  const isMeal = document.getElementById('sf-meal')?.checked || false;
  const entry = remove
    ? { id, remove: true }
    : {
        id,
        day: openDay,
        time: value('sf-start'),
        endTime: value('sf-end'),
        item: value('sf-item'),
        presenter: value('sf-presenter'),
        location: value('sf-location'),
        isMeal,
        note: isMeal ? value('sf-menu') : '',
      };

  // How much later everything after this now sits, if anything.
  const before = minutesOf(item?.rawEndTime || item?.rawTime);
  const after = remove ? null : minutesOf(entry.endTime || entry.time);
  const delta = before !== null && after !== null ? after - before : 0;
  const anchor = item?.rawTime;

  const path = id ? 'schedule-edit' : 'schedule';
  const { ok, body } = await call(`/sessions/${scheduleSessionId}/${path}`, {
    method: 'POST',
    body: JSON.stringify(entry),
  });
  if (!ok) return say(body.error || 'That did not save.');

  closeScheduleForm();
  lastSchedule = body;
  drawSchedule(body, true);

  if (!remove && id && delta !== 0 && anchor) {
    await offerShift(anchor, delta, false);
  } else {
    say(remove ? 'Removed.' : 'Saved.', 'good');
  }
}

// Never rewrites a run of the day without showing what it is about to move.
async function offerShift(afterTime, minutes, includeAnchor) {
  const preview = await call(`/sessions/${scheduleSessionId}/schedule-shift`, {
    method: 'POST',
    body: JSON.stringify({ day: openDay, afterTime, includeAnchor, preview: true }),
  });
  const moving = preview.ok ? preview.body.moving : [];
  if (!moving.length) return say('Saved.', 'good');

  openDialog((panel) => {
    const direction = minutes > 0 ? 'later' : 'earlier';
    const size = Math.abs(minutes);
    panel.innerHTML =
      '<h2>Move what comes after?</h2>' +
      `<p class="lede">${moving.length} ${moving.length === 1 ? 'item' : 'items'} on this day would move ` +
      `${size} ${size === 1 ? 'minute' : 'minutes'} ${direction}.</p>`;

    const list = document.createElement('div');
    for (const row of moving.slice(0, 6)) {
      const line = document.createElement('p');
      line.className = 'hint';
      line.textContent = `${row.time}  ${row.item}`;
      list.append(line);
    }
    if (moving.length > 6) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `and ${moving.length - 6} more`;
      list.append(more);
    }
    panel.append(list);

    const move = document.createElement('button');
    move.type = 'button';
    move.textContent = 'Move them';
    move.addEventListener('click', () => applyShift(afterTime, minutes, includeAnchor));
    panel.append(move);

    const leave = document.createElement('button');
    leave.className = 'linkish';
    leave.type = 'button';
    leave.textContent = includeAnchor ? 'Cancel' : 'Leave them where they are';
    leave.addEventListener('click', closeScheduleForm);
    panel.append(leave);
  });
}

async function applyShift(afterTime, minutes, includeAnchor) {
  const { ok, body } = await call(`/sessions/${scheduleSessionId}/schedule-shift`, {
    method: 'POST',
    body: JSON.stringify({ day: openDay, afterTime, includeAnchor, minutes }),
  });
  if (!ok) return say(body.error || 'Could not move them.');
  closeScheduleForm();
  say(`${body.moved} ${body.moved === 1 ? 'item' : 'items'} moved.`, 'good');
  lastSchedule = body;
  drawSchedule(body, true);
}

// The thing that actually happens at a session: the day is running behind.
function pushBackDialog(item) {
  openDialog((panel) => {
    panel.innerHTML =
      '<h2>Running late?</h2>' +
      `<p class="lede">Move ${escape(item.item)} and everything after it on this day.</p>`;
    const row = document.createElement('div');
    row.className = 'action-row';
    for (const minutes of [15, 30, 60]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = minutes === 60 ? '1 hour' : `${minutes} min`;
      button.addEventListener('click', () => applyShift(item.rawTime, minutes, true));
      row.append(button);
    }
    panel.append(row);
    const cancel = document.createElement('button');
    cancel.className = 'linkish';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeScheduleForm);
    panel.append(cancel);
  });
}

/* ---------- session lifecycle ---------- */

function landOn(signedInAccount) {
  account = signedInAccount;
  document.getElementById('greeting').textContent = `Jai Swaminarayan, ${account.firstName}`;
  document.getElementById('account-role').textContent =
    account.role === 'karyakar' ? 'Karyakar' : 'Delegate';
  accountBar.hidden = false;
  clearMessage();
  buildTabs(account.role);
  selectTab(account.role === 'karyakar' ? 'sessions' : 'today');
}

function signOut(reason) {
  forgetToken();
  lastPayload = {};
  lastSessions = null;
  lastDashboard = null;
  account = null;
  openSessionId = null;
  openPerson = null;
  currentTab = null;
  lastDirectory = null;
  lastStanding = null;
  lastSchedule = null;
  scheduleSessionId = null;
  stopPolling();
  clearQr();
  accountBar.hidden = true;
  tabBar.hidden = true;
  document.body.classList.remove('has-tabs');
  show('login');
  if (reason) say(reason, 'notice');
}

async function submitting(form, work) {
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working...';
  try {
    await work();
  } catch {
    say('Cannot reach the server. Check your connection and try again.');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

document.getElementById('form-login').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const id = form.id.value.trim().toUpperCase();
  const pin = form.pin.value;
  clearMessage();

  submitting(form, async () => {
    const { ok, body } = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ id, pin }),
    });
    if (ok) {
      storeToken(body.token);
      form.reset();
      landOn(body.account);
      return;
    }
    if (body.needsPinSetup) {
      pendingId = id;
      form.reset();
      say('This ID has no PIN yet. Choose one now.', 'notice');
      show('setpin');
      document.getElementById('setpin-pin')?.focus();
      return;
    }
    say(body.error || 'That did not work. Try again.');
  });
});

document.getElementById('form-setpin').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const pin = form.pin.value;
  clearMessage();
  if (pin !== form.confirm.value) {
    say('Those two PINs are not the same. Type them again.');
    return;
  }
  submitting(form, async () => {
    const { ok, body } = await call('/auth/set-pin', {
      method: 'POST',
      body: JSON.stringify({ id: pendingId, pin }),
    });
    if (!ok) return say(body.error || 'That did not work. Try again.');
    storeToken(body.token);
    form.reset();
    landOn(body.account);
  });
});

document.getElementById('setpin-cancel').addEventListener('click', () => {
  pendingId = '';
  clearMessage();
  show('login');
});

document.getElementById('signout').addEventListener('click', () =>
  signOut('Signed out. Jai Swaminarayan.')
);

document.getElementById('session-back').addEventListener('click', () => {
  openSessionId = null;
  openPerson = null;
  clearQr();
  clearMessage();
  showSessions();
});

document.getElementById('detail-back').addEventListener('click', () => showDirectory());
document.getElementById('my-session-back').addEventListener('click', () => showStanding());
document.getElementById('schedule-back').addEventListener('click', () => {
  closeScheduleForm();
  selectTab('sessions');
});

// Escape closes it, for anyone on a laptop.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('dialog-open')) {
    closeScheduleForm();
  }
});
document.getElementById('schedule-add').addEventListener('click', () => scheduleForm(null));
document.getElementById('qr-generate').addEventListener('click', generateCode);
document.getElementById('qr-save').addEventListener('click', saveCode);
document.getElementById('delegate-search').addEventListener('input', (event) =>
  renderDirectory(event.target.value)
);
document.getElementById('roster-add').addEventListener('click', () => {});

// Show and hide a PIN. Mistyping one you cannot see is the likeliest way to
// get locked out, and the lockout is fifteen minutes.
for (const button of document.querySelectorAll('.reveal')) {
  button.innerHTML = ICON.eye;
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.reveals);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    button.innerHTML = hidden ? ICON.eyeOff : ICON.eye;
    button.setAttribute('aria-label', hidden ? 'Hide PIN' : 'Show PIN');
    input.focus();
  });
}

// Offline support. Registration failing is not worth reporting: the app works
// perfectly well without it, it simply needs the network.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=37').catch(() => {});
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Once only. A reload loop with no address bar to escape it would be the
    // worst thing this file could do.
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// A stored token is only a claim. The Worker re-checks it, and re-checks that
// the account is still active, before anything is shown.
(async function resume() {
  if (!readToken()) return;
  try {
    const { ok, body } = await call('/me');
    if (ok) landOn(body.account);
    else forgetToken();
  } catch {
    forgetToken();
  }
})();
