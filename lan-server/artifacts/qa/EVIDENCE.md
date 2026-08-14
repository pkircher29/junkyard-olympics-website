# Final QA evidence

Generated: `2026-08-14T06:38:32-04:00`

These retained logs were produced from the source/test blobs listed below. The acceptance run used a fresh disposable SQLite database under `/tmp`, an imported loopback app, and two disposable high-entropy organizer credentials. Credential values are intentionally not retained.

## Results

- Authoritative Node acceptance contract: **25/25 passed**, zero skips (`acceptance-contract.tap`).
- Serialized Vitest suite: **181/181 passed** (`vitest.log`).
- Public print packet Pytest: **6/6 passed** (`print-packet-pytest.log`).
- TypeScript typecheck: passed (`typecheck.log`).
- TypeScript build: passed (`build.log`).
- Event-day simulation A: **68/68**, verdict PASS, zero product defects (`simulation-a.json`).
- Event-day simulation B: **68/68**, verdict PASS, zero product defects (`simulation-b.json`).

## Exercised source/test blobs

| File | Git blob | SHA-256 |
|---|---|---|
| `src/app.ts` | `67b3528b290800bbb16b99aca381748a13ef5416` | `765a6ee8b8f6d0c383404cf544cb2a7a8b526325165492d472abeec705d52189` |
| `tests/acceptance-contract.test.mjs` | `120b6a56d8f80573ced07cfce88de83c2673c17c` | `e49df860447e64915166c259e65e3d57e1d0e754b2ec82b6208db1b80dfcf0fd` |
| `tests/latest-domain-blockers.test.ts` | `fda7c96bab33a052678d686c5fba95e293f5e140` | `2e547962d37ecbd58bd1a2f568ab4a4497eece0e1013e12cbee5b0babca5c262` |
| `tests/fresh-adversarial.test.ts` | `1f445eb895ede7045d942fae25751b2fd2969fbe` | `4560ba70b6dcb7d37a7d310970069fb3a2c104f834ed53b0cb6b75b623a15e87` |

## Evidence checksums

| File | SHA-256 |
|---|---|
| `acceptance-contract.tap` | `77542d99d53c8ef76da493e250f527a8ee991b9bdc5502a855fd160bd6893bba` |
| `vitest.log` | `cd227f6a42ee6994664e78ab91c07bfa1414c835da1b9c2dc3b522cf588a7ad6` |
| `print-packet-pytest.log` | `7d34aea2505acc167794e84113877dfea1284447cb16c5e2736ac479e0887bef` |
| `typecheck.log` | `834cb194fe17f86b1200a2cf61ef20dc4baa05520a81064aa0504e5d44a65188` |
| `build.log` | `4abd2dae3b59a397b23bdc8e62ed4ef45062540304dcdccc49524ff925ff26d1` |
| `simulation-a.json` | `0fa9c60425d2787c160950d5202f0be9151b7c8172d45b92a381fa770a62000c` |
| `simulation-b.json` | `18d266104cb8d7295d093d57d964327c8ffb65fa81526892741b68495c17c3d5` |

The simulations were generated immediately before the final acceptance-oracle-only edits. Their `exactSha` identifies the application commit they exercised; the `src/app.ts` blob hash above is the stronger byte-level binding and remained unchanged.
