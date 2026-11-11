# SimuLab backend progress

## 2026-11-05 - Repository baseline and synchronization
- Backend repository contains its original README only; no API, authentication, database, compilation workers, accounts or payments are implemented.
- Phase1/Phase2 work is in the independent frontend and engine repositories. Their versioned interfaces are documented before future integration.
- Created this progress record as required by workspace instructions, so future agents can identify the current backend status.
- User explicitly authorized committing/pushing all repositories. This backend commit is documentation only; no build/test scripts exist to run.
- Existing branch/remote: main, origin at sudipchakraborty/simulab-backend. Remote synchronization is verified after push.
- Next backend work remains Phase5, after contracts, authorization, isolation, schema/storage and compilation security requirements are agreed.

## 2026-11-06 - Components and integrated IDE in progress
- User master request retained at workspace docs/SIMULAB_REQUEST.md; checklist: docs/SIMULAB_IMPLEMENTATION_PLAN.md. Work is on feature/components-ide in all three repositories; no commits/pushes.
- Added restricted loopback Node companion with fixed Arduino CLI board profiles, bounded source projects, origin/host/bearer validation, single-use upload consent, port/library discovery and compile logs/diagnostics/artifacts.2 HTTP/security tests passed with explicitly marked CLI test double. Official CLI1.5.1 archive hash verified and AVR1.8.6 core locally installed; real compile and ESP core setup running. No physical uploads performed.

### Software verification checkpoint - 2026-11-06
-2 security/HTTP tests pass, including source bounds, origin/token, upload replay, library allowlist and detected-board mismatch. Actual Uno and original ESP32 sample builds passed; S3/N16R8 compilation is still running. Local cache includes CLI1.5.1, AVR1.8.6, ESP32 core3.3.8 and Adafruit NeoPixel1.15.5. COM3/COM4 discovered without identified boards; no flashing or physical serial was performed. Cold-build limits/caching and verification-client header timeout corrected; current runner is bounded600seconds.

## Final implementation handoff - 2026-11-06
- Local Node companion0.1.0 implements fixed board profiles, compile logs/diagnostics/artifacts, ports/libraries, source/host/origin/token validation, single-use60s upload consent and detected-board mismatch protection.2 HTTP/security tests and dependency audit passed; no runtime npm dependencies.
- All4 actual compile profiles passed: Uno, ESP32 DevKit, ESP32-S3 DevKit and generic-compatible YD N16R8 (FlashSize16M/PSRAMopi). Intentional build failure and diagnostic mapping passed. Reports: docs/TOOLCHAIN_REPORT.json. NeoPixel1.15.5 installed locally and actual compiled laboratory verified in browser.
- Cold builds exposed180s and600s timeouts, Node fetch300s header timeout, and an interrupted core.a omitting a valid main object. Reconstructing the archive linked the real S3 binary without firmware/source substitutions. Runner now supports trusted1000..1800000ms timeout (600000 default), bounded output, Windows tree termination and reusable per-board caches. Failed jobs retain error logs and invalidate the interrupted core archive. Verification client supports selected target resume using Node HTTP.
- Remaining boundaries: no identified physical target was flashed or used for USB serial/debug/parity. COM3/COM4 were discovered only. Exact YD module/revision and full flash/PSRAM address capacity are unverified. Original ESP32 execution, S3 external I2C/WS waveforms, source/DWARF/GDB debug, encoder variant and full analog/mains/current-safety solving remain unsupported. No commits, pushes or deployment; changes remain on feature/components-ide.

### Final gate closed - 2026-11-06
- Final production Chromium10/10 passed, including actual compiled Arduino S3 browser UART/GPIO4. Frontend99, engine19, ESP adapter5 and backend2 tests passed; builds, asset hashes and audits passed. All4 board compile profiles passed. Both generic and compatible N16R8 S3 Arduino binaries booted with firmware-hash/UART/GPIO evidence. Software implementation complete; physical and explicitly unsupported gates remain documented.
- Final handoff: frontend docs/COMPONENTS_IDE_TEST_REPORT.md and docs/INTEGRATED_IDE.md; backend README.md and docs/TOOLCHAIN_REPORT.json; workspace docs/SIMULAB_IMPLEMENTATION_PLAN.md. Changes remain local/uncommitted on feature/components-ide. Temporary verification companion is stopped after testing; start npm.cmd start in simulab-backend for a new private pairing token.

## App started - 2026-11-06
- Reused running frontend at http://127.0.0.1:5174/ and verified HTTP200.
- Started local companion at127.0.0.1:4317 with a fresh in-memory pairing token; authenticated status confirms Arduino CLI available. Trusted cold-build timeout1800000ms. Token is not stored in project documentation.


## 2026-11-06 - Account API domain
- Added reusable `src/accounts/service.mjs`, `server.mjs`, and `mailer.mjs`, plus independent `src/account-server.mjs`/`npm run start:accounts` on loopback 4320. Hardware companion source is unchanged.
- Persistent SQLite stores salted scrypt credentials, hashed opaque session/token secrets, ownership-scoped projects, roles, subscription expiry, payments and audit events. No first-signup admin; trusted bootstrap only, last-admin protection, all trial/expired writes denied including admin. Password reset and logout revoke sessions; login rotates cookies. Single-use verification opens the frontend and issues a persistent verified session.
- Added strict origins and CSRF for browser mutations, HttpOnly/SameSite cookies, configurable secure cookies, request size and login/signup throttling. Six user theme preferences are atomically persisted in server SYSTEM JSON, independently of project write permissions.
- Added SMTP configuration via Nodemailer and explicitly enabled local development outbox. No live email was sent. Checkout remains disabled without a configured positive minor-unit amount, currency and QR image. Client reference submission remains pending; audited admin approval or validated injected-provider/HMAC webhook grants entitlement. Event/payment replay and mismatched amounts/currencies are rejected or idempotent.
- Added README.account.md and .env.accounts.example covering startup, trusted bootstrap, API envelopes, transport setup and missing payment/SMTP configuration. Added nodemailer, lockfile and Node 24 requirement (built-in SQLite experimental warning remains expected).
- Verification: account security tests were written and run RED before implementation; final `npm test` passed all 5 tests (3 new account workflow/security/persistence suites + 2 original companion tests). Covered signup/verification replay, session cookies, trial/paid/viewer enforcement, ownership, strict origin/CSRF, forged/mismatched/replayed signed payments, reset revocation, session/theme restart persistence and last-admin protection. `npm audit --omit=dev`: zero vulnerabilities. No charge, deployment, commit or push performed.

### Account review and real browser verification follow-up
- Fixed a real authority race: protected POST authorization is refreshed after asynchronous request body reads, so logout/reset/role changes during a streamed request cannot authorize a stale session. A failing HTTP streaming regression now returns 401 after revocation.
- Independent review by the account UI agent found SMTP downgrade and failed-delivery recovery issues. Nonimplicit TLS SMTP now requires STARTTLS before authentication; a local fake SMTP transcript proves plaintext AUTH is not attempted. Failed verification delivery can be retried with the same correct signup credentials; added generic rate-limited `/api/auth/resend-verification` with rotated single-use proof.
- Signup/forgot responses identify safe transport mode without exposing tokens. Reset links use frontend `?reset=`. Trial begins at successful email verification, with a fake-clock regression covering delayed verification.
- Added real account browser harness in frontend scripts; production HTTP API has no test bypass. Production Playwright run passed 16 and explicitly skipped 3 real-companion scenarios requiring a caller-supplied token. Backend account tests cover eight workflows/security cases plus existing companion tests; final full test/audit results follow in parent verification.

## Final gate closed - 2026-11-06, milestone0.5
- Frontend140/140 unit/component tests, engine21/21, ESP adapter5/5 and backend10/10 passed. Latest strict TS/Vite build and vendored executable/firmware/engine hashes passed; all3 production dependency audits reported0vulnerabilities.
- Final production Chromium21/21 passed with real account API/outbox (no auth bypass), actual CLI Uno compile/run, genuine S3 compiled image and native Nano/Mega Workers/instruction debugger. No optional tests skipped. Compiler tests serialize single-job companion use; test login is worker-scoped to respect production rate limiting.
- Dark/light account/studio screenshots reviewed; header layout corrected. Signup/verification, trial denial across Save/export/CtrlS/autosave/serial export, identity isolation, theme reload and reset verified. Backend tests cover HMAC authenticity/amount/replay, ownership/RBAC, SMTP encryption, session-stream revocation and trial start.
- App running http://127.0.0.1:5174 (HTTP200), API4320 via /api proxy (HTTP200), compiler companion4317. Private local development outbox: backend .local/mail-outbox; messages are NOT delivered email. Live SMTP/provider/price/currency/QR remain unconfigured. No real charge, hardware upload/comparison, commit/push or deployment.
- Handoff: frontend docs/ACCOUNTS_COMPONENTS_REPORT.md, src/models/README.md, backend README.account.md/.env.accounts.example and engine firmware/mega2560-metadata.json. Full analog/SPICE, ADC/SPI/EEPROM/MegaUSART1-3, vendor robot protocols and source/GDB debugging remain explicit limits.

## 2026-11-11 - Verified account/compiler service release
- User explicitly authorized check/commit/push of all SimuLab repositories. Publishing existing feature/components-ide to origin; no main merge, PR or deployment requested.
- Fresh backend gate10/10 passed: verified sessions/RBAC/owner projects/theme persistence, CSRF/origin, expiry/replay/forged payment rejection, streamed-session revocation, verification recovery, mandatory STARTTLS and verification-time trial start, plus paired compiler/input/upload-consent checks. Production npm audit0vulnerabilities.
- Staged source/docs/tests/config example and lockfile reviewed; no real SMTP/payment/companion secret included. Runtime accounts.sqlite/SYSTEM.json/outbox, compiler downloads/jobs/caches, node_modules and logs remain ignored. Live delivery/provider pricing/QR configuration remains user-supplied; no real email/charge/physical upload performed.
