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
let qrTimer = null;

// A scanned code arrives in the URL. It is kept for this tab only, and the
// address bar is cleaned so the code is not left lying around in a share or a
// screenshot of the browser.
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

function scanFor(sessionId) {
  return scanned && scanned.sessionId === sessionId ? scanned.code : null;
}

// Tabler icons, inlined. No icon library, no emoji.
const ICON = {
  eye: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/></svg>',
  eyeOff: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"/><path d="M16.681 16.673a8.7 8.7 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.3 9.3 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"/><path d="M3 3l18 18"/></svg>',
};

function show(name) {
  for (const [key, section] of Object.entries(views)) section.hidden = key !== name;
  if (name !== 'session' && name !== 'delegate') stopPolling();
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

  const panel = document.getElementById('qr-panel');
  panel.hidden = !open;
  if (!open) clearQr();

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

/* ---------- the check-in code, drawn as a QR ---------- */

function qrDataUrl(text, scale = 8, quiet = 4) {
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
      if (matrix[r][c]) {
        context.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return canvas.toDataURL('image/png');
}

function clearQr() {
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
  document.getElementById('qr-holder').hidden = true;
}

async function generateCode() {
  clearMessage();
  const { ok, body } = await call(`/sessions/${openSessionId}/checkin-code`, {
    method: 'POST',
  });
  if (!ok) return say(body.error || 'Could not make a code.');

  const url = `${location.origin}${location.pathname}?s=${encodeURIComponent(openSessionId)}&c=${encodeURIComponent(body.code)}`;
  const image = qrDataUrl(url);
  document.getElementById('qr-image').src = image;

  const save = document.getElementById('qr-save');
  save.href = image;
  save.download = `bkst-checkin-${openSessionId}.png`;

  document.getElementById('qr-holder').hidden = false;

  const expiresAt = Date.now() + body.secondsLeft * 1000;
  const countdown = document.getElementById('qr-countdown');
  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    countdown.textContent = left
      ? `Expires in ${minutes}:${seconds}`
      : 'Expired. Generate a new code.';
    countdown.dataset.expired = left ? 'false' : 'true';
    if (!left) clearQr();
  };
  tick();
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(tick, 1000);
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

function startPolling(refresher) {
  stopPolling();
  const refresh = refresher || refreshSession;
  pollTimer = setInterval(() => {
    // Not while a karyakar is mid-decision on a name.
    if (!openPerson && !document.hidden) refresh();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}


/* ---------- delegate: their own year ---------- */

const SESSIONS_IN_A_YEAR = 6;

async function showStanding() {
  show('delegate');
  await refreshStanding();
  // The window can open while a delegate is already looking at this screen.
  startPolling(refreshStanding);
}

async function refreshStanding() {
  const { ok, body } = await call('/me/standing');
  if (!ok) return say(body.error || 'Could not load your sessions.');
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
  return session.ended ? 'Not recorded' : 'Not yet';
}

function renderStanding(standing) {
  const allowance = document.getElementById('allowance');
  const spent = standing.absencesUsed;
  allowance.textContent = `${spent} of ${standing.absencesAllowed} absence used`;
  allowance.dataset.spent = spent > 0 ? 'true' : 'false';

  // A session with its check-in window open is the one happening now, whatever
  // the calendar says. Only when nothing is open does the next date win.
  const next =
    standing.sessions.find((session) => !session.ended && session.checkinOpen) ||
    standing.sessions.find((session) => !session.ended);
  const card = document.getElementById('next-card');
  card.hidden = !next;
  if (next) {
    document.getElementById('next-when').textContent = dateRange(
      next.startDate,
      next.endDate
    );
    document.getElementById('next-where').textContent = next.location;

    // Without a scanned code there is nothing to press. Section 9: a warning
    // names its remedy, so the screen says where the code comes from.
    const code = scanFor(next.id);
    const button = document.getElementById('checkin');
    button.hidden = !next.canCheckIn || !code;
    button.onclick = () => checkIn(next.id, code);
    document.getElementById('next-scan').hidden = !next.canCheckIn || Boolean(code);

    // Section 9: a warning names its remedy, or it is not shown. So a closed
    // window says nothing, but being already marked does.
    const hint = document.getElementById('next-hint');
    if (next.status === 'present') hint.textContent = 'You are checked in.';
    else if (next.status === 'absent') {
      hint.textContent =
        next.absenceOutcome === 'approved'
          ? 'This session is excused.'
          : 'You are marked absent for this session.';
    } else hint.textContent = '';
  }

  renderSlots(standing.sessions);
  renderSessionLines(standing.sessions);
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
  const list = document.getElementById('session-lines');
  list.textContent = '';
  for (const session of sessions) {
    const line = document.createElement('div');
    line.className = 'session-line';
    line.innerHTML =
      '<div class="session-line-head">' +
      `<h2>${escape(dateRange(session.startDate, session.endDate))}</h2>` +
      `<span class="chip" data-status="${slotStatus(session) === 'upcoming' ? 'not_checked_in' : slotStatus(session)}">${escape(statusWords(session))}</span>` +
      '</div>' +
      `<p>${escape(session.location)}</p>`;
    // Section 6: a denied absence states its reason, and the delegate sees it.
    if (session.decisionNote) {
      const note = document.createElement('div');
      note.className = 'decision';
      note.textContent = session.decisionNote;
      line.append(note);
    }
    list.append(line);
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

/* ---------- session lifecycle ---------- */

function landOn(signedInAccount) {
  account = signedInAccount;
  document.getElementById('account-name').textContent =
    `${account.name} - ${account.role === 'karyakar' ? 'Karyakar' : 'Delegate'}`;
  accountBar.hidden = false;
  clearMessage();
  if (account.role === 'karyakar') showSessions();
  else showStanding();
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
  clearQr();
  clearMessage();
  showSessions();
});

document.getElementById('qr-generate').addEventListener('click', generateCode);

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
