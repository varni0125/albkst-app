// BKST frontend.
//
// This file decides nothing about who you are, what you may see, or what
// anything counts for. It sends what you did to the Worker and renders the
// answer, including the Worker's own wording for every refusal.

const API = 'https://bkst-api.bkst.workers.dev';
const TOKEN_KEY = 'bkst.token';
const POLL_MS = 8000;

const views = {
  login: document.getElementById('view-login'),
  setpin: document.getElementById('view-setpin'),
  sessions: document.getElementById('view-sessions'),
  session: document.getElementById('view-session'),
  delegate: document.getElementById('view-delegate'),
};
const message = document.getElementById('message');
const accountBar = document.getElementById('account-bar');

let account = null;
let pendingId = ''; // carried from the login screen into first-PIN setup
let openSessionId = null;
let openPerson = null; // bkId whose actions are showing
let pollTimer = null;

// Tabler icons, inlined. No icon library, no emoji.
const ICON = {
  eye: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>',
  eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.7 8.7 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.3 9.3 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>',
};

function show(name) {
  for (const [key, section] of Object.entries(views)) section.hidden = key !== name;
  if (name !== 'session') stopPolling();
}

function say(text, tone = 'problem') {
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
}

const clearMessage = () => say('');

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function call(path, options = {}) {
  const token = readToken();
  const response = await fetch(API + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(options.headers || {}),
    },
  });
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
    // Private browsing can refuse storage. The session still works until the
    // page is reloaded, which beats refusing to sign in.
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clean up if storage was never available.
  }
}

/* ---------- dates ---------- */

// "Sept 11-13" from two ISO dates, without pulling in a date library.
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

/* ---------- session list ---------- */

async function showSessions() {
  show('sessions');
  const { ok, body } = await call('/sessions');
  if (!ok) return say(body.error || 'Could not load the sessions.');

  const list = document.getElementById('session-list');
  list.textContent = '';
  for (const session of body.sessions) {
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

/* ---------- one session ---------- */

async function openSession(sessionId) {
  openSessionId = sessionId;
  openPerson = null;
  clearMessage();
  show('session');
  await refreshSession();
  startPolling();
}

async function refreshSession() {
  const { ok, body } = await call('/sessions/' + openSessionId);
  if (!ok) {
    say(body.error || 'Could not load that session.');
    return;
  }
  renderSession(body.session, body.roster);
}

function renderSession(session, roster) {
  document.getElementById('session-title').textContent = dateRange(
    session.startDate,
    session.endDate
  );
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

  document.getElementById('session-tally').textContent =
    `${roster.present} of ${roster.total} checked in`;

  renderRoster(roster);
}

function renderRoster(roster) {
  const container = document.getElementById('roster');
  container.textContent = '';

  for (const group of roster.groups) {
    const section = document.createElement('div');
    section.className = 'center-group';
    const head = document.createElement('div');
    head.className = 'center-head';
    head.innerHTML =
      `<span>${escape(group.center)}</span><span>${group.present} of ${group.total}</span>`;
    section.append(head);

    for (const person of group.members) section.append(personRow(person));
    container.append(section);
  }
}

function statusLabel(person) {
  if (person.status === 'present') return ['present', 'Present'];
  if (person.status === 'absent') {
    return person.absenceOutcome === 'approved'
      ? ['excused', 'Excused']
      : ['absent', 'Absent'];
  }
  return ['not_checked_in', 'Not in yet'];
}

function personRow(person) {
  const wrap = document.createElement('div');
  wrap.className = 'person';

  const [status, label] = statusLabel(person);
  const row = document.createElement('button');
  row.className = 'person-row';
  row.type = 'button';
  const used = person.absencesUsed
    ? ` &middot; ${person.absencesUsed} of 1 absence used`
    : '';
  row.innerHTML =
    `<span class="person-name">${escape(person.name)}</span>` +
    `<span class="person-meta">${escape(person.grade)}th${used}</span>` +
    `<span class="chip" data-status="${status}">${label}</span>`;
  row.addEventListener('click', () => {
    openPerson = openPerson === person.bkId ? null : person.bkId;
    refreshSession();
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
    note.textContent = [person.reason, person.decisionNote]
      .filter(Boolean)
      .join(' - ');
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

  const reset = document.createElement('button');
  reset.className = 'linkish';
  reset.type = 'button';
  reset.textContent = 'Reset this PIN';
  reset.addEventListener('click', () => resetPin(person));
  panel.append(reset);

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

async function mark(person, entry) {
  clearMessage();
  const { ok, body } = await call(`/sessions/${openSessionId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ bkId: person.bkId, ...entry }),
  });
  if (!ok) return say(body.error || 'That mark did not save.');
  openPerson = null;
  const session = await call('/sessions/' + openSessionId);
  if (session.ok) renderSession(session.body.session, session.body.roster);
}

async function setWindow(state) {
  clearMessage();
  const { ok, body } = await call(`/sessions/${openSessionId}/window`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  });
  if (!ok) return say(body.error || 'Could not change the check-in window.');
  if (typeof body.markedAbsent === 'number' && body.markedAbsent > 0) {
    say(
      `${body.markedAbsent} ${body.markedAbsent === 1 ? 'delegate was' : 'delegates were'} marked absent. Tap a name to change it.`,
      'notice'
    );
  }
  await refreshSession();
}

async function resetPin(person) {
  const { ok, body } = await call('/auth/reset-pin', {
    method: 'POST',
    body: JSON.stringify({ id: person.bkId }),
  });
  say(ok ? body.message : body.error || 'Could not reset that PIN.', ok ? 'good' : 'problem');
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    // Not while someone is mid-decision on a name.
    if (!openPerson && !document.hidden) refreshSession();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ---------- session lifecycle ---------- */

function landOn(signedInAccount) {
  account = signedInAccount;
  document.getElementById('account-name').textContent =
    `${account.name} - ${account.role === 'karyakar' ? 'Karyakar' : 'Delegate'}`;
  accountBar.hidden = false;
  clearMessage();
  if (account.role === 'karyakar') showSessions();
  else show('delegate');
}

function signOut(reason) {
  forgetToken();
  account = null;
  openSessionId = null;
  openPerson = null;
  stopPolling();
  accountBar.hidden = true;
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
      document.getElementById('setpin-pin').focus();
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

document.getElementById('signout').addEventListener('click', () => signOut());

document.getElementById('session-back').addEventListener('click', () => {
  openSessionId = null;
  openPerson = null;
  clearMessage();
  showSessions();
});

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
