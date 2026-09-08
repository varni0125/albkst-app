// Login screen.
//
// This file decides nothing about who you are or what you may see. It sends
// what you typed to the Worker and renders the answer, including the Worker's
// own wording for every refusal.

const API = 'https://bkst-api.bkst.workers.dev';
const TOKEN_KEY = 'bkst.token';

const views = {
  login: document.getElementById('view-login'),
  setpin: document.getElementById('view-setpin'),
  signedin: document.getElementById('view-signedin'),
};
const message = document.getElementById('message');

// The ID typed on the login screen, carried into the set-PIN screen so nobody
// types it twice.
let pendingId = '';

function show(name) {
  for (const [key, section] of Object.entries(views)) {
    section.hidden = key !== name;
  }
}

function say(text, tone = 'problem') {
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
}

function clearMessage() {
  say('');
}

async function call(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // A response with no JSON body is still a failure worth reporting.
  }
  return { ok: response.ok, status: response.status, body };
}

function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing can refuse storage. The session still works until the
    // page is reloaded, which is better than refusing to sign in.
  }
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clean up if storage was never available.
  }
}

function showSignedIn(account) {
  document.getElementById('signedin-name').textContent = account.name;
  document.getElementById('signedin-id').textContent = account.id;
  document.getElementById('signedin-role').textContent =
    account.role === 'karyakar' ? 'Karyakar' : 'Delegate';
  clearMessage();
  show('signedin');
}

// Disables the button while a request is in flight, so a slow connection
// cannot become two check-ins or two PINs.
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
      showSignedIn(body.account);
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

    if (!ok) {
      say(body.error || 'That did not work. Try again.');
      return;
    }

    storeToken(body.token);
    form.reset();
    showSignedIn(body.account);
  });
});

document.getElementById('setpin-cancel').addEventListener('click', () => {
  pendingId = '';
  clearMessage();
  show('login');
});

document.getElementById('signout').addEventListener('click', () => {
  forgetToken();
  clearMessage();
  show('login');
  document.getElementById('login-id').focus();
});

// A stored token is only a claim. The Worker re-checks it, and re-checks that
// the account is still active, before anything is shown.
(async function resume() {
  const token = readToken();
  if (!token) return;
  try {
    const { ok, body } = await call('/me', {
      headers: { authorization: 'Bearer ' + token },
    });
    if (ok) showSignedIn(body.account);
    else forgetToken();
  } catch {
    // Offline on load: leave the sign-in screen up rather than a stale name.
    forgetToken();
  }
})();
