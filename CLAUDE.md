# BKST App — working conventions

Standing tracker for Bal-Kishore Sevak Training delegates, Alabama pilot:
25 delegates across five centers, six three-day sessions a year.
The full specification is `docs/spec.md`. Read it before proposing work.

## Current phase

**Phase 1**, of which only **manual score entry** is left. Built and tested on
real devices: auth for both roles, the roster, the check-in window, the QR
check-in gate, self check-in, manual marking and corrections, absence
requests, the delegate directory, and the needs-attention dashboard.

Quizzes, the grading queue, homework upload, and practice mode are Phases 2–4.
Do not build them, scaffold them, or add "for later" hooks for them, until I
say the phase has changed.

Build the karyakar side first and well — it is the real product.

## Process

- **Confirm design decisions with me before writing code.** Describe the
  approach, wait for a yes, then implement.
- **Give me complete files, not patches.** Every changed file comes back whole,
  ready to save over the old one.

## Architecture

- **Vanilla JS. No framework**, no build step, no bundler, no npm UI packages.
- `docs/` is the frontend. GitHub Pages serves the site from this folder.
- `worker/` is the Cloudflare Worker — the API and the only thing that touches
  the Google Sheet and Drive.
- **All auth and grading logic lives in the Worker, never the frontend.**
  Role is checked server-side on every request, not just at login. A delegate
  changing a URL must not reach karyakar data. The frontend renders what the
  Worker returns; it never decides who may see it and never computes a grade.
- **A rule enforced only in the page is not a rule.** Anything the browser
  refuses, the Worker must refuse too. A denied absence needs its reason
  checked in both places, not just the one you can see.

## Things that have already bitten

- **Google allows 60 Sheets reads a minute.** Tab reads are cached in the
  Worker for this reason. Twenty-five delegates checking in at once went past
  the limit and the app started failing, at the worst possible moment.
- **That cache lives in one isolate**, and a write only clears the isolate
  that made it. Anything deciding on current state — approving a request,
  marking attendance — must read past the cache, or the same decision can be
  applied twice.
- **A cache miss reads every tab in one batched request**, not one request per
  tab. Twenty-five people opening the app at once, each reading four tabs
  separately, was a hundred reads against a limit of sixty.
- **Google serialises writes to a single spreadsheet.** Twenty-five delegates
  tapping check-in at once, each writing its own row, was measured at 16 of 25
  succeeding with waits of up to five minutes. Self check-ins now go to a
  durable buffer, one per session, which flushes everything as a single append
  a second later: 25 of 25, slowest 2.7 seconds. Never write one row per
  request on a path a whole room uses at once.
- **An append updates the cache rather than clearing it.** Clearing it meant
  each check-in forced the next one to re-read the whole spreadsheet.
- **Appends use `insertDataOption=OVERWRITE`, not `INSERT_ROWS`.** An inserted
  row copies the formatting of the row above it, so on an empty tab the first
  attendance row came out navy with cream bold text — unreadable — and every
  row after inherited it. The data rows are pre-formatted several hundred deep
  and appends write into them.
- **The check-in window state lives in the durable object, not the Sheet.**
  Read from the Sheet it comes through the per-isolate cache, so opening
  check-in cleared it for one request while everyone else read a copy still
  saying closed. Measured: twenty-three of thirty delegates told check-in was
  not open, seconds after a karyakar opened it. The Sheet stays the record;
  the object is the answer.
- **A failed read serves the last good copy rather than an error.** Slightly
  old data beats telling someone their screen is broken when it is a few
  seconds behind.
- **Attendance is append-only and reconciled by `marked_at`**, never by row
  order. The sheet is something karyakars will sort.
- **Dates in the sheet must stay `yyyy-mm-dd`.** They are compared as strings.
- **The service worker fetches the page network-first, on purpose.** Serving
  a cached page first is how people end up stranded on an old version with no
  address bar to escape through. Static files are cache-first only because
  they carry a `?v=` stamp, and the API is never cached at all: an attendance
  count from ten minutes ago is worse than admitting there is no connection.
- **Reading the code is not testing it.** Three bugs this project shipped past
  review were invisible on the page but obvious on a phone: the wrong session
  card, a save button Safari ignores, and a `hidden` attribute beaten by a CSS
  `display` rule. Anything visual needs a real device before it counts as
  working.

## Styling

- **No hardcoded hex values.** Every color comes from a token in
  `docs/tokens.css`. Need a color that isn't there? Ask before adding one.
- **No emoji anywhere** — UI, code, comments, or commit messages.
  **Tabler icons only.**
- Serif for headlines, names, and questions; sans for UI and answers.
- The palette is dark, and the meanings are unchanged: red is a real
  consequence, gold is worth-a-word, green is passing. **The action colour is
  cream, not gold.** Gold already means soft warning, and section 9 forbids the
  brand colour and the alarm colour being cousins — the reason maroon was
  rejected. Returning to the cream ground is a `tokens.css` edit and nothing
  else, which is the whole point of the no-hex rule.
- One action-colored element per screen. Generous whitespace, hairline borders,
  no gradients, no shadows.
- Every warning names its remedy, or isn't shown at all.
- Keep `[hidden] { display: none !important }` in `app.css`. Any class that
  sets `display` beats the browser's own rule, and hiding then silently fails.
- `docs/manifest.webmanifest`, the `theme-color` meta tag, and the small inline
  style in the head are the only places colours are written out rather than
  referenced: none of them can read a CSS variable, and the inline one has to
  be there before any stylesheet loads or the first paint is white. They
  duplicate the ground colour; change `tokens.css` and change them too.

## Secrets

- **Never commit secrets.** No API keys, no service account JSON, no PINs, no
  passwords — not in code, not in comments, not in test fixtures.
- Local Worker config goes in `worker/.dev.vars`; deployed config goes in
  Wrangler secrets. Both are gitignored.

## Deploying

**Deploy the Worker before pushing frontend changes.** The frontend on GitHub
Pages goes live the moment it is pushed; if it calls an endpoint that isn't
deployed yet, the app is broken in production.

1. `wrangler deploy` from `worker/`
2. Verify the endpoint responds
3. Bump the `?v=` on the `tokens.css`, `app.css`, `qr.js`, `app.js` and
   `manifest.webmanifest` tags in `docs/index.html`, and on the `sw.js`
   registration in `docs/app.js`. The service worker serves static files
   cache-first, so a file whose URL does not change is a file that never
   updates
4. Then commit and push `docs/`

GitHub Pages serves everything with `cache-control: max-age=600`, so a phone
holds a stale copy for up to ten minutes after a push. The `?v=` bump means
CSS and JS refresh the moment the HTML does, instead of ten minutes later
again. Nothing can shorten the wait on `index.html` itself — when testing a
fix, use a private tab.
