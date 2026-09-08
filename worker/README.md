# Worker

Cloudflare Worker for the BKST app — the API, and the only code that touches
the Google Sheet and Google Drive.

All auth and grading logic lives here. See `../CLAUDE.md` for conventions and
`../docs/spec.md` for the specification.

Nothing is implemented yet; Phase 1 design is still to be confirmed.

## Local config

Secrets go in `worker/.dev.vars` (gitignored) for local runs and in Wrangler
secrets for the deployed Worker. Never commit them.
