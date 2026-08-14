# Browser Surface Map

All surfaces use local assets and support `?demo=1` without a backend.

| Surface | Route | Expected API integration |
|---|---|---|
| Signup | `/` | `POST /api/participants`, `GET /api/state` |
| Participant | `/participant.html` | `/api/me`, match report/confirm, Flair APIs, event stream |
| Organizer | `/organizer.html` | `/api/organizer/*`, event stream |
| Cannon | `/cannon.html` | `/api/cannon/lanes/:id/shots`, organizer target APIs |
| Station | `/station.html` | `/api/stations/:id/check-in`, event stream |
| TV | `/tv.html` | `/api/state`, `/api/events`, production QR image endpoint if provided |
| Emergency packet handoff | `/print.html` and `/print` | redirects/hands off to `/public-print-packet.pdf`; contains no event state |
| Verified public packet | `/public-print-packet.pdf` | committed reproducible PDF; public QR signs and blank paper ledgers only |

`public/js/api.js` centralizes fetch paths and credentials. `public/js/demo-data.js` is preview-only mock state; official calculation remains server-authoritative.
