# Homestead (phone app)

The household's phone app for Vanessa and Cade: Expo SDK 58 (React Native 0.88, React 19.3), TypeScript, Expo
Router, development builds (not Expo Go). It looks and behaves like the approved Phase 2 prototype
(`prototype/homestead.html`, Gate 2) and talks only to the API at `services/api`. It never moves money and never
holds a bank password, a BC credential or a client secret.

The Phase 3 spec names Expo SDK 55; SDK 58 is the current stable release and is what is installed.

## What it does

| Screen (spec) | Route | What it shows |
| --- | --- | --- |
| H1 Home | `app/(tabs)/index.tsx` | Safe to spend until payday with its status chip and "as of" stamp, the one-sentence forecast, Needs your answer (at most three cards, each with its "why"), the paycheck card, bills before payday, the goals peek, recent activity, the Ask bar |
| Safe to spend, in parts (V2) | `app/safe-to-spend.tsx` | Cash, set-asides, bills before payday (each listed), giving due, the floor ("Not set yet" until approved), result, next payday, per-day figure, "Data through … · N items pending"; when short, one small move with "Send to …" |
| H2 Camera | `app/snap.tsx` | Full-screen camera with a frame; snaps by itself when the phone is steady (accelerometer), or on the shutter, or with the system document scanner (edge detection) |
| H3 Receipt card | `app/receipt/[clientId].tsx` | The photo; "Saved on your phone — not synced yet" offline, "Sending…", "Reading your receipt…", then merchant, total, date, split; **Done** (tap three) |
| H4 Needs your answer | `src/ui/QuestionCard.tsx` | One-tap cards from `GET /v1/questions`, answered with `POST /v1/questions/{id}/answer` |
| H5 Activity | `app/(tabs)/activity.tsx` | Search, All / Needs answer / With receipt / Mine, the plain status words, receipts still on the phone at the top |
| H6 Item detail | `app/transaction/[id].tsx` | Amount and status, receipt photo (or a drawn receipt), split lines, paycheck breakdown, "This isn't spending" for transfers, **This is wrong**, **Mark as business**; "Fix pending — Cade will fix it in the books" |
| H7 Category picker | `app/wrong/[id].tsx` | Five suggestions plus search in household words; "Do this every time for …?" proposes a rule |
| Mark as business | `app/business/[id].tsx` | CTJ, Lash, or keep personal |
| H8 Budget + H10 Approvals | `app/(tabs)/budget.tsx` | "Sample budget until ours is approved", flexible-spending bar, category rows with left/budget and On track / Watch / Action needed (allowances: "No alerts"), the other spouse's requests (**Approve with Face ID** / **Not now**), ours waiting |
| H9 Move money | `app/move-money.tsx` | Amount, source, the effect on both categories, an optional note; sent to the other spouse |
| H11 Goals | `app/(tabs)/goals.tsx` | Emergency fund, next debt, set-asides; "sample target" / "Target not set yet" |
| H12 Ask Homestead | `app/ask.tsx` | Starters, answers with "Data through … · N items pending", a drafted move opens Move money prefilled |
| H13 Bills | `app/bills.tsx` | Upcoming bills with payday marked and "before payday" |
| H14 Settings | `app/settings.tsx` | Name, Face ID, notifications, quiet hours (view), linked logins (status only), Export my data (step-up), Alerts, Sign out |
| Alerts inbox | `app/alerts.tsx` | Action needed / Watch / This week cards |
| Sign-in, first run | `app/sign-in.tsx`, `src/ui/FaceIdIntro.tsx`, `src/ui/FaceIdGate.tsx` | Passkey sign-in through the browser, "One more thing: Face ID", the Face ID lock |

The "Uploading 2 receipts…" / "You're offline…" bar (`src/ui/SyncBar.tsx`) sits above every tab screen while
anything waits to sync.

### Under the screens

- `src/api/client.ts` — the typed HTTP client against `services/api/openapi.yaml`; `src/api/mock.ts` — `MockApi`,
  the prototype's sample data with the API's rules (other spouse decides, step-up, hash dedupe, fix-pending);
  `src/api/hooks.ts` — React Query hooks and `usePeople()` (who is who, from `GET /v1/me`).
- `src/auth/` — Entra External ID sign-in (code + PKCE through the system browser, discovery from the tenant),
  tokens in SecureStore (this device only), refresh, sign-out; Face ID on open (passkey again after 30 days or 7
  days without a refresh); step-up (`stepUp.ts`: a fresh Face ID inside 2 minutes; in Entra mode a token is
  re-acquired after the local check so its `iat` is fresh).
- `src/receipts/` — compress to a JPEG of at most 1.5 MB, SHA-256 (native), save under the document directory,
  record in the offline queue (`queue.json`, a client-minted `man:<uuid>`), upload with backoff (1 s doubling to
  5 minutes, with jitter), resume on reconnect and foreground. The same hash is never uploaded twice: the queue
  refuses it and the API answers 200 "already held". Synced photos are pruned from the phone after 30 days.
- `src/model/` — the safe-to-spend view model, plain status words, sync words, dates and money, household
  category names, who does what.
- `src/push/notifications.ts` — permission, the Expo push token sent to `POST /v1/devices/push-token`, routing a
  tapped notification.
- `src/ui/` — the prototype's tokens (`theme.ts`) and building blocks.

## Run it

```sh
# once, from the repo root
flock /tmp/homestead-pnpm.lock pnpm install

# a development build on the iOS simulator, mock mode (no backend, sample data)
cd apps/mobile
cp .env.example .env        # names only; set EXPO_PUBLIC_API_MODE=mock, EXPO_PUBLIC_AUTH_MODE=dev
npx expo run:ios            # builds the native app once; afterwards `pnpm start` serves the JS

# against a local API (services/api with AUTH_MODE=dev)
EXPO_PUBLIC_API_MODE=http EXPO_PUBLIC_API_URL=http://localhost:8080 \
EXPO_PUBLIC_DEV_MEMBERS="Vanessa:<member uuid>,Cade:<member uuid>" npx expo run:ios

# on Vanessa's iPhone: an EAS development build (needs the Apple team and EAS project id)
eas build --profile development --platform ios
```

Checks (all from the repo root or the package):

```sh
pnpm --filter @homestead/mobile typecheck   # tsc --noEmit (also what `build` runs)
pnpm --filter @homestead/mobile test        # vitest, the pure modules
maestro test apps/mobile/.maestro/receipt-three-taps.yaml   # on a simulator with a mock-mode development build
```

Metro needs no monorepo configuration beyond Expo's defaults (SDK 52+ sets watch folders and node_modules paths
itself; `npx expo export --platform ios` bundles cleanly). `metro.config.js` adds one thing: `@homestead/shared`
imports `node:crypto`, which Metro maps to `src/shims/node-crypto.ts` (SHA-256 in TypeScript). No
`node-linker=hoisted` was needed.

The route root is pinned with `["expo-router", { "root": "./app" }]` in `app.json`: Expo Router silently prefers
a `src/app` folder when one exists, and an empty one left by an earlier build made the bundle ship with no screens.

## Environment

Everything is read at build time from `EXPO_PUBLIC_*` variables, each as a literal `process.env.EXPO_PUBLIC_X`
(Expo inlines only that form). None is a secret.

| Name | Meaning |
| --- | --- |
| `EXPO_PUBLIC_API_MODE` | `mock` (default; `MockApi`, no backend) or `http` |
| `EXPO_PUBLIC_API_URL` | The API base URL in http mode |
| `EXPO_PUBLIC_AUTH_MODE` | `dev` (default; sends `x-dev-member`, and `x-step-up: true` after a fresh Face ID) or `entra` |
| `EXPO_PUBLIC_DEV_MEMBERS` | Dev mode: `Name:memberId,Name:memberId` from the seed |
| `EXPO_PUBLIC_ENTRA_TENANT_NAME` | The `<tenant>` in `<tenant>.ciamlogin.com` |
| `EXPO_PUBLIC_ENTRA_TENANT_ID` | Tenant GUID, used in the issuer path when set |
| `EXPO_PUBLIC_ENTRA_CUSTOM_DOMAIN` | `homestead.cadejonescpa.com` (passkeys bind to it); when set the issuer is `https://<domain>/<tenant id>/v2.0` |
| `EXPO_PUBLIC_ENTRA_CLIENT_ID` | The phone app registration (public client, PKCE); redirect `homestead://auth` |
| `EXPO_PUBLIC_ENTRA_API_SCOPE` | `api://<api client id>/Household.ReadWrite` |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | For Expo push tokens (or `app.json` `extra.eas.projectId`) |
| `EXPO_PUBLIC_BOOKKEEPER_NAME` | Who fixes entries already in the books; default `Cade` |

## Mock mode

`EXPO_PUBLIC_API_MODE=mock` serves the prototype's sample data: $1,012.02 in checking, $300 set aside, the Verizon
and Rocky Mountain Power bills before a Friday payday at least three days out, the Walmart / Venmo / Amazon
questions, Cade's $75 move request, the sample budget, goals and bills. State lives in memory for the session.
Sign in as Vanessa or Cade to see either side of an approval. A snapped receipt "uploads", reads for a moment, and
comes back as the prototype's Broulim's split. Without a camera (simulator, permission refused) the bundled sample
receipt stands in so the flow still runs; in http mode a refused camera says how to turn it on instead.

## Tests

- Unit (vitest, 69 tests): `test/queue.test.ts` (enqueue, dedupe by hash, flush oldest first, retry with backoff,
  rejects, crash recovery, restart, pruning), `test/sync.test.ts` (API answers mapped to queue outcomes; nothing sent
  offline, everything sent once on reconnect; timed retry), `test/safeToSpendVm.test.ts` (hero card words, short
  state, parts, payday and data-through lines, client-side composition, forecast sentence), `test/status.test.ts`
  (every state to Vanessa's words, calm colors, row icons, sync words, who-does-what), `test/stepUp.test.ts` (the
  2-minute window, ask-first vs ask-when-required, the Face ID lock, the 7-day/30-day session rules),
  `test/client.test.ts` (paths, bodies, headers and error mapping against the OpenAPI document, fallbacks),
  `test/mock.test.ts` (sample data and the API's rules in the mock), `test/theme.test.ts` (WCAG AA for every
  text color pair).
- Device: `.maestro/receipt-three-taps.yaml` — Home → Snap → shutter (or auto-capture) → Done, then the receipt in
  Recent activity and no sync bar.

## What is stubbed, faked or left for the device

- No backend is needed in mock mode; nothing in mock mode is real money.
- Push: the token is registered; sending (Expo push service, quiet hours, one alert per problem) is the API's job.
  Without an EAS project id, push registration is skipped quietly.
- Export: `POST /v1/export` queues the job (202); the time-limited link arrives later from the API, not in the app.
- Linked logins in Settings are status only; adding or re-linking a bank login (Plaid Link) is not in this build.
- Receipt photos on the phone are protected by iOS Data Protection (`NSFileProtectionCompleteUnlessOpen`
  entitlement in `app.json`; the Data Protection capability must be on for the App ID) and Android file-based
  encryption, not by an app-level cipher; the server stores the encrypted original.
- Not run here: the native build, the camera, Face ID, push and the Maestro flow need a Mac with Xcode or an EAS
  build. The JS bundle was verified with `npx expo export --platform ios`.

## OpenAPI reconciliation (openapi.yaml v0.2.0, Oct 20, 2026)

The client uses `/v1/me`, `/v1/safe-to-spend`, `/v1/accounts`, `/v1/transactions` (+ `/{id}`, `/correct`,
`/business`), `/v1/questions` (+ `/answer`), `/v1/receipts` (multipart) and `/{id}`, `/v1/paychecks`,
`/v1/budget`, `/v1/budget/moves`, `/v1/approvals` (+ `/decide`), `/v1/rules` (propose), `/v1/goals`, `/v1/bills`,
`/v1/ask` (+ `/history`), `/v1/alerts`, `/v1/devices/push-token`, `/v1/export`, and `/v1/console/settings` only as a
fallback. Paths, bodies and envelopes match the document. Differences worth knowing:

1. Receipt upload field: the E6 brief says `clientId`; the API and the document use `offlineId`. The app sends
   `offlineId` (the `man:<uuid>` queue id).
2. Deciding a budget move, rule, settings or correction approval needs step-up for **declines too** (the API's
   `STEP_UP_KINDS`). The prototype's "Not now" had no Face ID; the app now asks for it only when the API says
   `step_up_required`, then retries once.
3. `/v1/safe-to-spend`'s `billsBeforePayday` carries dates and amounts only; the app joins names from `/v1/bills`
   by date and amount. A `name` (or bill id) on those lines would remove the join.
4. `/v1/safe-to-spend` has no forecast sentence; the app writes it from `/v1/budget`'s `forecastCents`.
5. Fallbacks for an API older than v0.2.0, each only on 404: `/me` derived from the sign-in, approvals and
   `/console/settings`; `/safe-to-spend` → `/bills/safe-to-spend` → computed on the phone with the shared
   calculation; `/alerts` → `/console/alerts`; push-token ignored; export "not available yet".
6. A paycheck deposit's Transaction has no paycheck id, and `/v1/paychecks/{id}` takes the paycheck's own id, so
   item detail lists `/v1/paychecks` and matches `transactionId`. A `paycheckId` on the Transaction would save that.
7. `ReceiptDetail` has no image link, so the photo shows only on the phone that took it (for 30 days); elsewhere item
   detail draws the receipt from its read lines. A short-lived signed image URL would let both phones show it.
8. Alert snooze (`POST /v1/alerts/{id}/snooze`) and the receipts list are not used by the phone yet.

## Deviations from the prototype, and why

- **Contrast.** Two text colors are darker than the prototype's so every text pair passes WCAG AA (a Phase 1
  rule): stamps and placeholders (`faintText`, 4.7:1 instead of 2.7:1) and the Watch pill's words (`watchText`,
  4.9:1 instead of 3.7:1). Bars, dots, borders and chevrons keep the prototype colors. Chips and small buttons
  keep their 40-point look with a hit area stretched to 44 points.
- **No scene switch, user switch or reset in Settings** (the brief); the numbers are whatever the API says.
- **Approvals also appear in Home's Needs your answer**, because `/v1/questions` lists them; the prototype showed
  them on Budget only. They are on Budget too.
- **"Not now" may ask for Face ID** (OpenAPI note 2).
- **The breakdown sheet has more lines**: each bill before payday, the payday and per-day figure, giving due when
  there is any, and the floor ("Not set yet"), following the Phase 1 definition. "Cash in checking and savings"
  replaces "Cash in checking" for the same reason.
- **The camera is real**: auto-capture by holding steady (with an Auto on/off), the shutter, and "Scan edges" (the
  system document scanner). The prototype simulated a timed snap; the sample receipt does that only in mock mode
  without a camera.
- **The receipt card shows where the receipt is** (sending, not synced yet, reading, read), confirms a split that
  needs it with "Yes, looks right" / "Change", and offers "Snap it again" / "Remove" for an unreadable photo.
- **Ask** uses the brief's "Data through … · N items pending" and shows earlier answers; a drafted move opens
  Move money prefilled. Move money uses chips instead of a drop-down and has an optional note.
- **First run** is the real sign-in (passkey through the browser, or the dev member picker) followed by the
  prototype's "One more thing: Face ID" step; there is no "Who's trying it?" screen.
- **Additions** the prototype did not have: an alerts inbox (from Settings; the avatar shows a count), the Face ID
  lock screen, the sync states on Activity rows, and "Mine" based on the FAMILY_AREA dimension.

## Questions for Cade

1. Entra step-up: does `amr` (mfa/fido) survive a refresh-token grant in the External ID tenant? The app
   re-acquires a token after Face ID so `iat` is fresh; if `amr` is dropped on refresh, every approval would need a
   passkey prompt (`prompt=login`) instead, which is much clumsier for Vanessa. Worth one test in the sandbox tenant.
2. Should declining a budget move ("Not now") really need Face ID? The API requires it today; the prototype didn't.
3. Is iOS Data Protection enough for receipt photos on the phone, or do you want an app-level cipher (a native
   crypto module, one more dependency)?
4. Bookkeeper wording: fixes to posted items say "Cade will fix it in the books" (configurable). Right for the
   pilot?
5. The "Mine" filter uses the FAMILY_AREA dimension (CADE / VANESSA). Should it instead mean "the accounts I own"
   or "receipts I snapped"?
