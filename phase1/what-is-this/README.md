# COLDPATH — "What is this?" first-run explainers

One document per ingestion path. These are the standalone versions of the panels shown inside the app the first time a user opens that path. They exist so a new user understands what is about to happen to their data **before** it happens, and so the explanation can be circulated without the application open.

Each panel is shown once per path and can be re-opened at any time from the ⓘ header. Both versions are generated from the same source object, so the app and these documents cannot drift apart.

| # | Path | Document | Gates |
|---|---|---|---|
| 1 | CRM target list | [`01-crm-target-list.md`](./01-crm-target-list.md) | C1–C9 + G0–G9 |
| 2 | LinkedIn Sales Navigator capture | [`02-sales-navigator-capture.md`](./02-sales-navigator-capture.md) | L1–L12 + G0–G9 |
| 3 | BD reports & activity records | [`03-bd-reports-and-activity.md`](./03-bd-reports-and-activity.md) | R1–R10 + G0–G9 |
| 4 | SalesIntel enrichment feed | [`04-salesintel-feed.md`](./04-salesintel-feed.md) | S1–S8 + G0–G9 |
| 5 | SalesIntel field specification | [`05-salesintel-field-spec.md`](./05-salesintel-field-spec.md) | S1–S8 + G2–G4 |

## The three commitments behind all five paths

1. **Nothing enters without provenance.** Who supplied it, when, from where, under what licence. Non-nullable. A record without provenance is rejected, not stored with blanks.
2. **Nothing is silently overwritten, merged or dropped.** Every gate that discards, defers or conflicts writes to a review queue a human can see.
3. **Refusing is a success state.** A gate that blocks bad data has worked. A gate that lets it through quietly has failed.

## Why these exist at all

The ask was for context and peace of mind on first use, not on every use. That distinction matters: a system that re-explains itself becomes noise and gets ignored, and then the explanation is not there when someone actually needs it.

So each panel shows once per path, can be dismissed, and can be re-opened from the header. The standing guarantee is not "we explain it once" — it is that **every refusal is visible, attributed and reversible**, which is what the panels are describing.
