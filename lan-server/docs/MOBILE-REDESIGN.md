# Mobile Participant Redesign — Friday Acceptance Contract

**Source:** Chris’s physical phone test on the `Junkyard Olympics` Wi-Fi, August 13, 2026.

## Problem

The current participant screens technically fit a phone but still behave like a desktop tournament dashboard. They use the palette without creating the illustrated scrapyard world from the canonical shirt art. The experience feels dense, basic, and unfamiliar.

## Required Mobile Flow

### Signup

One vertical story:

1. Full-width illustrated Junkyard hero with logo, flame cannon, gorilla/scrap detail, and clear `SATURDAY · 2 PM` badge.
2. One large question: **“What should we call you?”**
3. One large display-name field.
4. One large action: **“Pick my events”**.
5. Event selection expands as large illustrated/tactile cards, not settings rows.
6. Cannon is clearly marked as required for championship podium.
7. One large final action: **“Enter the Junkyard”**.
8. Confirmation immediately says identity is saved to this phone and provides **“Open my dashboard”**.

### Participant Dashboard

One vertical feed ordered by urgency:

1. Greeting and completion/progress strip.
2. **DO THIS NOW** card only when the participant has a called match; plain language, station name, opponent names, countdown, one huge check-in action.
3. **UP NEXT** events as readable cards.
4. **YOUR RESULTS** compact cards.
5. **FLAIR / SHOWBOAT** action.
6. **CHAMPIONSHIP STANDINGS** preview.
7. Device reset/sign-out buried at the bottom, not competing with event actions.

No tab row is required for primary navigation on phones. Anchor links are acceptable only if the page is long.

## Visual Contract

Use `/assets/tshirt-brand.png` or a mobile crop derived from the canonical source art.

- Hero is artwork-led, not text-led.
- Palette: flame orange, rust red, dirty cream, faded grass, soot black, gunmetal.
- Heavy black comic outlines.
- Distressed/condensed sports display type for headings; readable system sans for body copy.
- Cards feel like dented signs, steel plates, taped paper, and painted equipment tags.
- Use bolts, hazard stripes, tire tracks, torn edges, smoke, and flames sparingly as framing details.
- Preserve enough empty cream space for readability.
- Avoid generic neon, glassmorphism, gradients, polished SaaS cards, tiny all-caps paragraphs, and spreadsheet tables.

## Mobile Usability Contract

At a 390×844 viewport:

- Body copy is at least 17px.
- Input text is at least 20px.
- Primary actions are at least 56px tall.
- Interactive event cards are at least 72px tall.
- Tap targets have at least 12px separation.
- No horizontal scrolling.
- No content clipped under headers.
- No more than one primary action visible in the same card.
- Critical instruction is plain language before decorative language.
- The first signup action is visible without scrolling on a common phone.
- The called-match action is visible without scrolling when present.
- Reduced-motion mode remains usable.

## Truthfulness

- Live state comes from real APIs.
- Empty state says what is needed next.
- Demo data is never presented as live.
- Controls unsupported by the backend are absent or disabled with an explanation.

## Acceptance Evidence

1. 390×844 screenshots of signup top, event selection, participant called-match state, and participant empty state.
2. Browser console free of errors.
3. Keyboard and touch flow exercised.
4. Signup through the live API on a disposable database.
5. Participant identity survives refresh.
6. Existing security, domain, build, and simulation gates remain green.
7. Chris repeats the physical phone test on the outdoor Wi-Fi.
