# What is this? — Capturing what you found in Sales Navigator

**Path 2 of 5 — LinkedIn Sales Navigator capture** · COLDPATH ingestion engine · first-run explainer · gates L1–L12 + G0–G9

---

## What this is

A paste box. You copy whatever you found — a profile, a lead card, a search result — and drop it in. The engine parses it, records **who found it and exactly when**, and files it against the right account.

## Why it exists

Sales Navigator caps exports at 25 leads per action and automated collection violates LinkedIn's terms and risks account bans. Manual capture by a logged-in rep is the compliant path — and it has a real advantage: a human looked at it.

## What happens to your data

Every step below is a gate. Each one passes, warns, or refuses — and every refusal is recorded with a reason and lands in a review queue a human can see. The queue is surfaced on the Command dashboard as well as on the Ingest overview, so nothing waits silently on a screen nobody opened.

**L1** — Confirm this is a manual, one-at-a-time capture. Bulk paste is refused — that is a terms-of-service gate, not a convenience.

**L2** — Record who captured it, automatically from your session. Not editable.

**L3** — Record when, automatically, to the second.

**L4** — Ask for the profile URL. Without it the capture is still accepted, but visibly weaker.

**L5** — Parse name, headline, company, location, connection degree and tenure. Each field is marked **clean** or **inferred**, and inferred fields are shown to you for confirmation.

**L6** — Tag every field as something you **saw** or something you **concluded**. Both are useful; only one is a fact.

**L7** — Cap confidence at level 2. No user action can raise it.

**L11** — Set a 180-day expiry. LinkedIn profiles go stale silently.

## What we will never do with it

- Scrape, automate, or collect in bulk.
- File a guessed field silently — inferred values are shown to you first.
- Let a level-2 record reach an outbound sequence uncorroborated.
- Store apparent protected-characteristic data. That field is quarantined.

## What could go wrong, and how you would know

- You mis-copy and the wrong title is filed. The raw text you pasted is retained verbatim forever, so any extraction can be audited against what you actually supplied.

- The person has moved on. The 180-day expiry catches this automatically and downgrades the record.

- SalesIntel disagrees with you. Both are kept, both dated, and the conflict goes to the marketer. Neither wins silently.

## If something looks wrong

Mark it wrong and it drops to confidence 1 immediately. Your correction is the training signal, not an inconvenience.

---

Full gate definitions, refusal behaviour and acceptance tests: [`INGESTION-GATES.md`](../INGESTION-GATES.md).
