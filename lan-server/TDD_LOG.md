# TDD execution log

Vertical feature tests were authored before production source. The initial RED command and subsequent GREEN commands are recorded below.

- RED: `npm test` — failed because `../src/db.js` did not exist.
- GREEN iteration: `npm test` — 8 failures / 2 passes exposed auth precedence and endpoint behavior gaps.
- GREEN iteration: `npm test` — 2 failures / 8 passes exposed SQLite boolean conversion and an ambiguous reporter fixture.
- GREEN: `npm test` — 10/10 API tests passed.
- Persistence RED/GREEN: backup/restore test was added and implementation completed using `Database#backup`; full suite reached 11/11.
- Bracket advancement RED: focused test failed because confirmed winners did not create round two; GREEN created the next match atomically and locked late championship entry when semifinals begin.
- Gate: `npm test && npm run typecheck && npm run build` — 12/12 tests passed, strict typecheck passed, build passed.
- Smoke: compiled server returned `{"ok":true,"database":"ready","migration":1}`, seeded 5 events, created a 184320-byte startup backup, restarted cleanly, and created a second backup.
- Competition-engine RED: `vitest run tests/competition-engine.test.ts` — 11/11 new tests failed for missing complete brackets, unified advancement, consolation/top-four finalization, placement validity, late entry, pairing/rename approval, substitution history/reversal, and scheduler eligibility.
- Competition-engine GREEN: focused `competition-engine`, `api`, and `persistence` suites passed 34/34; strict typecheck and production build passed.
- Disposable loopback acceptance: built server health returned migration 3; unmodified Node acceptance harness passed 5/25 and failed 20/25. Remaining failures are primarily broader contract aliases/Cannon run APIs/ops endpoints/UI markers outside this repair checkpoint.
