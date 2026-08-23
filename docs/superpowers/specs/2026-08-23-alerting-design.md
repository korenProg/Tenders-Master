# Alerting — Email on Health Signals — Design

**Date:** 2026-08-23
**Status:** Approved. Channel (Resend over HTTP), digest shape, and suppression policy settled 2026-08-23.
**Phase:** 5 of 5 on the road to ~1000 sites (follows concurrency)

## תקציר בעברית

שלב 5 סוגר את הפער האחרון: המערכת כבר **יודעת** לזהות אתר שנשבר, אבל אף אחד לא רואה את זה. `lib/health.js` מחשב בכל ריצה שלושה סיגנלים לכל אתר — אפס מכרזים מדף תקין, קריסה של יותר מחצי מהכמות, וכל המכרזים פגומים — והתוצאה מסתכמת בשורת לוג ובמונה. ריצה מתוזמנת שאיש אינו צופה בה הופכת את זה לחסר ערך: אתר שיישבר פשוט ייעלם מהמערכת של הלקוח בשקט. השלב מוציא את הסיגנלים האלה למייל. שלוש הכרעות עיצוב: **דוח אחד לריצה** ולא מייל לכל אתר, מה שמגביל את הנפח לכל היותר מייל אחד לריצה; **התראה על מעברים בלבד** — אתר ששבור שבוע לא מייצר מייל יומי; ו**Resend מעל HTTP** במקום SMTP, כי `axios` כבר תלוי בפרויקט ולכן זו תוספת של אפס תלויות. הלוגיקה שמחליטה מה השתנה נכנסת ל-`lib/alerts.js` הטהור ונבדקת אופליין; `main.js` רק שולח.

## Problem

The detection half already exists and works. [lib/health.js](../../../lib/health.js) runs per site, per run, and returns `{ level, signals }`:

| Signal | Catches | Level |
|---|---|---|
| `ZERO_FROM_HEALTHY_PAGE` | The page loaded fine (>1500 chars) and produced **zero** tenders | `ALERT` |
| `COUNT_COLLAPSE` | The site returned less than half of last run's tender count | `ALERT` |
| `ALL_DEGRADED` | Every extracted tender came back with a bad number or date | `WARN` |

What happens with that verdict today is the whole problem: a `console.log` line inside the site's log buffer, and a counter in the run summary. Nothing leaves the process.

The run is meant to be scheduled and unattended. So the realistic failure is silent: a municipality redesigns its tenders page, extraction returns zero, `ZERO_FROM_HEALTHY_PAGE` fires, and that city quietly disappears from the client's system until a human happens to ask why there are no tenders from Holon.

Two structural gaps compound it:

- **`processSite` throws the verdict away.** It computes `health` inside `validateAndDeliver` ([main.js:112](../../../main.js#L112) returns `{ ok, kept, health }`) and then returns nothing — every exit path is a bare `return;`. There is no channel from the per-site pipeline back to `run()`.
- **A site that crashes is never assessed at all.** `assessSite` runs only on the delivery path. A site that throws, or exceeds `SITE_TIMEOUT_MS`, never reaches it. After Phase 4 the pool already collects those into `failures` ([main.js:207-209](../../../main.js#L207-L209)) — the list exists and is printed, but nothing acts on it.

## Goals

1. An **email** when a site's health state changes, so an unattended run stops being a silent one.
2. **One digest per run**, never one email per site — this is what caps the volume.
3. **Transition-based suppression**: a site that has been broken for a week produces no daily mail.
4. Site **failures and timeouts** are alert-worthy, not just suspicious extractions.
5. The decision logic is **pure and unit-tested offline**, the same seam as `health.js` and `pool.js`. `main.js` only sends.
6. **Zero new npm dependencies.**
7. Every earlier-phase invariant survives untouched. This phase adds an output; it changes no pipeline semantics.

## Non-Goals

- **`WARN`-level emails.** `ALL_DEGRADED` is real but not urgent; it appears as context inside a digest that was sent for another reason, and never triggers one.
- **Periodic reminders** for a long-broken site. Rejected deliberately: it needs "when did we last nag" state and time logic, to solve a problem the per-run status table already solves.
- **A debounce / N-consecutive-runs delay.** Considered and rejected once the run frequency was known (1–2 runs per day): the digest already caps volume at one email per run, so a debounce buys almost no quiet while costing up to a full day of blindness. At an hourly schedule this decision would need revisiting.
- **Retry/backoff on a failed send.** The next run retries by construction (see the state-ordering invariant below).
- **Slack, SMS, or a second channel.** One channel, chosen.
- **HTML email design.** Plain text. The content is a status table, not a newsletter.
- **Alerting on run-level aggregates** (total tokens, total dropped). Per-site health is what indicates breakage.
- **Changing extraction, the paginator, the cache schema, or the webhook contract.**

## Architecture

### Split: pure decision + impure send

**`lib/alerts.js`** (pure, unit-tested):

```js
// Folds one run's per-site outcomes into the state we compare against history.
// Each entry: { url, publisher, state: 'ok'|'alert'|'failed', signals: string[], error?: string }
function buildRunStates(siteOutcomes) → Array<SiteState>

// What changed since the last email. `previous` is the stored map, keyed by url.
function diffAlertState(previous, current)
  → { newlyBroken: SiteState[], recovered: SiteState[], stillBroken: SiteState[], changed: boolean }

// The digest. Returns null when `changed` is false — "no email" is a value,
// not a special case the caller has to remember to check.
function renderDigest(diff, allStates, runMeta) → { subject, text } | null
```

`alerts.js` knows nothing about HTTP, disk, Resend, or Puppeteer. It is given outcomes and previous state; it returns a decision and a rendered body.

**`lib/alert-state.js`** (impure, thin): `load()` / `save(state)` for `alerts.json`, mirroring [lib/storage.js](../../../lib/storage.js)'s role for the cache — a swappable persistence seam, kept separate from the logic that uses it.

**`main.js`**: `processSite` returns its outcome instead of swallowing it; `run()` combines those with the pool's `failures`, calls into `alerts.js`, and POSTs to Resend.

### Three states, not a level

Each site lands in exactly one state per run:

- **`failed`** — threw, or exceeded `SITE_TIMEOUT_MS`. From the pool's `results[i].ok === false`.
- **`alert`** — completed, but `assessSite` returned `LEVELS.ALERT`.
- **`ok`** — everything else, including `WARN`.

A transition is a change in this three-value state. Nothing else triggers an email.

**Deliberate consequence:** a site whose signals change while staying in `alert` — `COUNT_COLLAPSE` becoming `ZERO_FROM_HEALTHY_PAGE` — sends no new email. An earlier draft treated that as a transition; it was dropped as complexity that buys little, since the site is already known-broken and the escalation appears in the next digest's status table. Listed under Known Limitations rather than hidden.

### Why one digest per run

Fourteen sites breaking together — a shared library change, a network outage, an expired API key — would produce fourteen unconnectable emails. One digest says "11 healthy, 3 broken, here they are" and is the shape a human can act on. It is also what makes the volume ceiling hard: **at most one email per run**, no matter how many sites break or flap, which at 1–2 runs per day is at most one or two emails per day in the worst case imaginable. Expect zero in most weeks.

### The digest

Subject carries the verdict so it is readable without opening: `🔴 2 sites broken — עיריית חולון, עיריית אשדוד` / `✅ עיריית חולון recovered`.

Body, plain text:
- What changed — newly broken sites with their signals or error message, and recovered sites.
- Sites still broken from before, each with the date it broke (the stored `since` field), so a long-standing failure is visible — and datable — whenever a mail goes out at all.
- A one-line status table of all 14 sites, for context.
- Run metadata already in `RUN_STATS`: duration, AI calls, tokens, sites completed.

### Sending

`POST https://api.resend.com/emails`, `Authorization: Bearer ${RESEND_API_KEY}`, JSON body `{ from, to, subject, text }` — the same axios-with-a-key shape the webhook already uses. New env: `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`.

**A missing `RESEND_API_KEY` disables alerting with one log line, and is not an error.** Local runs, `scrape-diff`, and any checkout without the key must keep working exactly as before.

### The state-ordering invariant, which is the OPPOSITE of the cache's

The cache is saved **before** delivery, because re-delivering is cheap and re-extracting is expensive ([main.js:203-213](../../../main.js#L203-L213)).

Alert state does the reverse: **send first, save state only after the send succeeds.** Re-sending an alert is cheap; losing one is not. If the send fails, the state file is left untouched, so the next run sees the same transition and tries again. Saving first would mean a single Resend outage permanently swallows the one alert that mattered.

Both orderings are correct, for opposite reasons. Anyone "fixing" one to match the other breaks it, which is why this is stated here.

### `alerts.json`

```json
{
  "version": 1,
  "updatedAt": "2026-08-23T09:00:00.000Z",
  "sites": {
    "https://www.holon.muni.il/...": {
      "publisher": "עיריית חולון",
      "state": "alert",
      "signals": ["ZERO_FROM_HEALTHY_PAGE"],
      "since": "2026-08-21T09:00:00.000Z"
    }
  }
}
```

Keyed by URL rather than by md5 like the cache: the cache hashes because it needs one file per site on disk; this is a single file, where a readable key is worth more. Gitignored, like `cache/`. A missing or malformed file means "no history" — the run reports current problems and writes a fresh v1 file, exactly as the cache handles a missing record.

## Data flow

```
runPool results ──┬─ ok:false ────────────► state: failed
                  └─ ok:true, outcome ────► state: alert | ok   (from assessSite)
                                │
                        buildRunStates
                                │
   alerts.json ──► diffAlertState ──► changed? ──no──► nothing sent, state untouched
                                │
                               yes
                                │
                          renderDigest ──► POST Resend ──► 200? ──► save alerts.json
                                                             │
                                                            no ──► leave state, retry next run
```

## Error Handling

| Situation | Behavior |
|---|---|
| `RESEND_API_KEY` unset | Alerting disabled, one log line, run otherwise unchanged |
| Resend returns non-2xx, or the request throws | Logged; `alerts.json` NOT updated; same transition retried next run |
| `alerts.json` missing or malformed | Treated as empty history; current problems reported; fresh v1 written |
| Nothing changed this run | No email, no write, no cost |
| A site fails *and* the email fails | Both are independent; the site's cache behavior is unaffected |
| Rendering throws | Caught in `run()`; the run must finish and report normally — an alerting bug must never take down extraction |

## Known Limitations

- **A signal change within `alert` does not re-notify.** Escalation from `COUNT_COLLAPSE` to `ZERO_FROM_HEALTHY_PAGE` is visible only in the next digest's status table.
- **No reminders.** A site broken for a month is silent unless some other site changes state.
- **Alerting is only as timely as the schedule.** At one run per day, a break is reported up to a day after it happens.
- **Local state.** Deleting `alerts.json` re-alerts every currently-broken site once. Harmless, but surprising.
- **A flapping site produces alternating broken/recovered mails**, bounded to one per run. If the schedule ever moves to hourly, this is the first thing to revisit — and the debounce rejected above is the fix.
- **`WARN` never emails**, by design. A site quietly degrading every number and date is visible only in logs.
- **Single recipient.** `ALERT_EMAIL_TO` takes one address; multiple recipients would be a comma-split away but are not built.

## Testing

`node:test`, no new dependencies, `npm test` stays **offline and zero-token** — no HTTP, no email, ever.

`lib/alerts.js`:
- `buildRunStates` maps pool failures to `failed`, `LEVELS.ALERT` to `alert`, and `WARN`/`OK` to `ok`.
- `diffAlertState`: an ok→alert site is newly broken; alert→ok is recovered; alert→alert is still-broken and does NOT set `changed`; failed→alert does set it; a site absent from history counts as newly broken if it is not ok.
- `changed` is false when every site holds its previous state — the "no email on a quiet run" guarantee.
- First run with no history and all sites healthy sends nothing.
- `renderDigest` returns `null` exactly when `changed` is false.
- The subject names the affected sites, and the body contains every newly-broken site's signals and every failed site's error message.
- Hebrew publisher names survive rendering intact.

`lib/alert-state.js`: round-trips a state object; a missing file yields empty history; malformed JSON yields empty history rather than throwing.

Not unit-tested, by the same reasoning as the rest of `main.js`: the Resend POST itself. It is one axios call in orchestration code, verified by a one-off manual send during implementation.

## Success Criteria

1. A site transitioning to broken produces exactly one email; the following run, still broken, produces none.
2. A recovery produces exactly one email.
3. A run where nothing changed sends nothing and writes nothing.
4. A failed or timed-out site is alerted on, not just a suspicious extraction.
5. A missing `RESEND_API_KEY` leaves the run byte-for-byte as it is today.
6. A failed send leaves `alerts.json` untouched, and the next run retries the same transition.
7. An error anywhere in alerting cannot fail the run.
8. `npm test` stays offline and zero-token.

## Roadmap Context

The last of five phases. Phase 1 built the health signals; this phase is what makes them matter. Phases 2 and 3 made the run cheap and uniform, and Phase 4 made it fast — this one makes it something nobody has to watch.
