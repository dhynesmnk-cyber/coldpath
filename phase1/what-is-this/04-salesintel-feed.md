# What is this? — Connecting SalesIntel

**Path 4 of 5 — SalesIntel enrichment feed** · COLDPATH ingestion engine · first-run explainer · gates S1–S8 + G0–G9

---

## What this is

A contracted feed of verified B2B contact data, ingested on a schedule. SalesIntel is unusual among enrichment providers in publishing its verification cadence — a **90-day human re-verification cycle**, with a 95% accuracy claim.

## Why it exists

It closes the gap public research cannot: named individuals at private companies. In the prototype, 5 of 17 executive records were published as gaps, and most were at private companies. This is the path that fills them.

## What happens to your data

Every step below is a gate. Each one passes, warns, or refuses — and every refusal is recorded with a reason and lands in a review queue a human can see. The queue is surfaced on the Command dashboard as well as on the Ingest overview, so nothing waits silently on a screen nobody opened.

**S1** — Confirm what the contract permits us to store, for how long, and whether derived analysis may be shown to third parties. Ingestion is blocked until Legal signs off.

**S2** — Track each contact's SalesIntel verification date. Inside 90 days → confidence 2. Outside → confidence 1 pending refresh.

**S3** — Refuse to inherit the aggregate accuracy claim. 95% across a portfolio is not a property of any individual record. We sample-audit our own observed accuracy over time.

**S4** — Treat emails and mobile numbers as PII: gated access, logged retrieval, suppressed from exports unless explicitly enabled.

**S5** — Confirm a lawful basis exists before any contact detail is used for outbound.

**S6** — Re-pull more often than the 90-day cycle, so a lapsed record is caught by us rather than by a bounced email.

**S7** — Reconcile against rep captures. Agreement is corroboration; disagreement is a conflict surfaced to a human.

## What we will never do with it

- Assume a 95% portfolio accuracy rate applies to a given record.
- Let a contact detail leave the system in an exported artefact unless explicitly enabled.
- Use a number or address for outreach before consent is confirmed.
- Auto-resolve a disagreement with a rep capture.

## What could go wrong, and how you would know

- A contact is stale. S2 downgrades it automatically at 90 days and it appears in the expired queue.

- SalesIntel and a rep disagree. Both retained, both dated, conflict raised. SalesIntel being a paid provider does not make it right.

## If something looks wrong

Every record carries its verification date and its source. When two sources agree inside their windows, that agreement is the strongest evidence available for a private-company executive who appears in no public filing.

---

Full gate definitions, refusal behaviour and acceptance tests: [`INGESTION-GATES.md`](../INGESTION-GATES.md).
