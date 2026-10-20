# Working rules for everyone building Homestead (Phase 4)

Read first: `docs/phase3-architecture-spec.md` (the approved spec), `packages/shared/src/*.ts` (the contracts: money,
states, idempotency, dimensions, chart, categories, paycheck, receipts, confidence, safeToSpend, types),
`services/api/db/migrations/0001_schema.sql` (the schema), `services/api/src/db/index.ts` (withHousehold, audit,
enqueueOutbox), `services/api/src/lib/auth.ts` (principal, hasFreshStepUp), `services/api/src/app.ts` (route loading).

Non-negotiables (from the brief; do not design around them):
- The app never moves money. Bank connections are read-only. No write to any bank or Plaid product that moves funds.
- Every accounting transaction follows the state machine in `@homestead/shared` (`assertTransition`), carries a stable
  idempotency key and a source reference, and stores the BC document/entry IDs after posting. No shadow ledger: if the
  app and BC disagree, BC wins and the app shows the difference.
- Auto-posting is off until a written rule is tested and approved; `ledger_connections.auto_post_enabled` and the
  rule's `may_auto_post` + `state='approved'` must both hold, and the five guard conditions (`ruleBlockReasons`) must be empty.
- Confidence tiers: high auto only under an approved rule; medium one-tap confirm; low review. Rules learn only from
  approved corrections. A merchant rule must not classify a purchase outside its amount band.
- Both spouses have equal visibility and equal approval rights; the other spouse decides an approval (DB constraint).
- Account numbers are masked (last four only). No SSNs, no bank credentials, no BC credentials on a phone. Receipt
  images encrypted at rest. Secrets stay out of code, logs and prompts: read them from env/Key Vault by *name*.
- Logs never carry amounts, masks, merchants, tokens or image URLs (`scrub`, `redactString` in services/api/src/lib/logScrub.ts).
- Money is integer cents everywhere. Dates are YYYY-MM-DD strings in America/Boise. Timestamps ISO 8601.
- Every number shown to a person carries a `dataThrough` (see `DataThrough` in shared/types.ts).

Engineering rules:
- TypeScript strict (tsconfig.base.json). ESM. Node 22. Vitest for tests. No `any` unless unavoidable and commented.
- Add dependencies by editing the package's package.json, then run `flock /tmp/homestead-pnpm.lock pnpm install`
  from the repo root (several people install at once; the lock prevents a corrupted lockfile). Prefer no new deps when
  the platform has it (fetch, crypto, URL).
- External services (BC, Plaid, Azure, Foundry) are unreachable from this environment. Build thin clients behind
  interfaces and test them against in-process fakes/fixtures that mirror the documented API shapes. Record every
  assumption about a vendor API in a comment with the doc URL from the spec's Sources.
- A local Postgres 16 is running: `DATABASE_URL="postgres://homestead@localhost:5433/<your db>?host=/tmp" PGSSLMODE=disable`.
  Use the database named in your brief. `pnpm --filter @homestead/api db:migrate` applies the schema. Integration tests
  must skip when DATABASE_URL is unset (see services/api/test/rls.test.ts for the pattern).
- Do not run `git commit` or `git push`; the coordinator commits. Do not edit files outside your area except the
  shared package's `types.ts` when a DTO is missing (add, never change existing fields) and the root README's
  "What's here" table for your area.
- `pnpm build && pnpm test` from the repo root must stay green. Run `node scripts/secrets-scan.mjs` before you finish.
- Write a short `README.md` in your package: what it does, how to run it, what is faked and why.
- Plain language in anything a person sees. Vanessa's screens use the five status words from `PLAIN_STATUS_WORDS`.
