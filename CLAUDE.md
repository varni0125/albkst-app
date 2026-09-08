# BKST App — working conventions

Standing tracker for Bal-Kishore Sevak Training delegates, Raleigh pilot.
The full specification is `docs/spec.md`. Read it before proposing work.

## Current phase

**Phase 1 only** — auth, roster, attendance (with the check-in window), and
manual score entry. Nothing else gets built yet.

Quizzes, the grading queue, homework upload, and practice mode are Phases 2–4.
Do not build them, scaffold them, or add "for later" hooks for them.

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

## Styling

- **No hardcoded hex values.** Every color comes from a token in
  `docs/tokens.css`. Need a color that isn't there? Ask before adding one.
- **No emoji anywhere** — UI, code, comments, or commit messages.
  **Tabler icons only.**
- Serif for headlines, names, and questions; sans for UI and answers.
- One action-colored element per screen. Generous whitespace, hairline borders,
  no gradients, no shadows.
- Every warning names its remedy, or isn't shown at all.

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
3. Then commit and push `docs/`
