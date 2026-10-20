# Developer setup

One `pnpm install` and one `pnpm build` cover every package. Node 22, pnpm 10.

## Local database

Any Postgres 16. The migrations create the `homestead_app` role (no login) and enable row-level security; connect as the
owner for migrations and tests, and as a login role that is a member of `homestead_app` for the API in production.

```
export DATABASE_URL=postgres://homestead@localhost:5432/homestead_dev
export PGSSLMODE=disable
pnpm db:migrate
```

## Running tests

- `pnpm test` runs every package's unit tests. `services/api` and `services/jobs` integration tests run only when
  `DATABASE_URL` is set (they migrate the database they are pointed at).
- `test/` holds the acceptance suite A1–A9. It needs the BC sandbox and Plaid Sandbox secrets as environment
  variables (names in `test/.env.example`) and is skipped without them. Nothing in it touches production.

## Environment variables

Every service has a `.env.example` listing names only. Values come from Key Vault in the cloud and from a local
`.env` (git-ignored) on a developer machine. `pnpm secrets:scan` fails the build if a value is committed.

## Auth in development

`AUTH_MODE=dev` makes the API trust an `x-dev-member: <member id>` header and `x-step-up: true` for step-up. Entra
External ID is used whenever `AUTH_MODE=entra` (the default in production).
