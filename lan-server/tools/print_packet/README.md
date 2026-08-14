# Public print packet generator

This local-only tool builds the event's copy-ready US Letter packet. It does not contact the server, deploy, submit credentials, or print.

## Exact setup

Use a dedicated tooling virtual environment; do not add these packages to the application `package.json` or runtime deployment:

```bash
cd "$(git rev-parse --show-toplevel)"
python3 -m venv .venv-print
.venv-print/bin/python -m pip install --upgrade pip
.venv-print/bin/python -m pip install -r tools/print_packet/requirements.txt
```

The committed artifacts were generated with Python 3.11.15 and the exact versions in `requirements.txt`. Base-14 PDF fonts are used, so no host font files are required.

## Generate and verify

```bash
.venv-print/bin/python tools/print_packet/generate.py
.venv-print/bin/python -m pytest tools/print_packet/test_generate.py -q
sha256sum -c <(sed -n 's/^\([0-9a-f]\{64\}\)  /\1  artifacts\/public-print-packet\//p' artifacts/public-print-packet/MANIFEST.txt)
```

Default output:

- `artifacts/public-print-packet/junkyard-olympics-public-print-packet.pdf`
- `artifacts/public-print-packet/pages/page-01.png` through `page-20.png`
- `artifacts/public-print-packet/MANIFEST.txt`

The generator replaces its output directory to prevent stale pages. It writes fixed metadata and a stable object order; the tests generate a second copy and compare every byte.

## Packet contract

1. Copy-ready index.
2. Public signup QR (`http://192.168.1.101:8790/`).
3. Eight reusable public station signs in `station-1` through `station-8` order.
4. One score/check-in fallback sheet for each of the eight official field games.
5. Separate Cannon Lane 1 and Lane 2 ledgers.

Horseshoes and Badminton appear only as **CASUAL ONLY — no station QR**. Cannon has no field-station QR. Public URLs contain no query, fragment, user info, bearer value, or private access code.
