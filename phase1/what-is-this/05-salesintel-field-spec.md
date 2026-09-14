# What is this? — Specifying what SalesIntel sends us

**Path 5 of 5 — SalesIntel field specification** · COLDPATH ingestion engine · first-run explainer · gates S1–S8 + G2–G4

---

## What this is

A field-level agreement about what arrives from SalesIntel and how each field is treated once it does. The mapping below is provisional — built from SalesIntel's published data model — and is replaced by the client's specific list when it arrives.

## Why it exists

An enrichment feed is only as useful as the fields it carries, and one field in particular decides whether the whole feed is trustworthy. Getting the specification right before the contract is signed costs nothing; getting it wrong afterwards means every contact arrives undated.

## What happens to your data

Every step below is a gate. Each one passes, warns, or refuses — and every refusal is recorded with a reason and lands in a review queue a human can see. The queue is surfaced on the Command dashboard as well as on the Ingest overview, so nothing waits silently on a screen nobody opened.

**S1** — Confirm what the contract permits us to store, for how long, and whether derived analysis may be shown to third parties.

**G3** — Check the critical fields are present: full_name, current_title, company, verification_date.

**S2** — Track each record's verification date against SalesIntel's 90-day human re-verification cycle. Inside the window → confidence 2. Outside → confidence 1.

**G4** — Resolve the company to a canonical account. NAICS codes are an exact join key to the RMP registry; name similarity is a fuzzy one, and fuzzy is what produced the VersaCold defect.

**S3** — Refuse to inherit the published 95% accuracy claim. It is a portfolio statistic, not a property of any individual record.

**S4** — Treat emails and direct dials as PII: gated access, logged retrieval, suppressed from exports unless explicitly enabled.

**S5** — Confirm a lawful basis before any contact detail is used for outbound. Blocking by default.

**S7** — Reconcile against rep captures and existing research. Agreement corroborates; disagreement becomes a conflict for a human.

## What we will never do with it

- Inherit a published accuracy rate onto an individual record.
- Let an email or mobile number leave the system in an exported artefact unless explicitly enabled.
- Use a contact detail for outreach before consent is confirmed.
- Accept a demographic or protected-characteristic field, raw or inferred. Refused at ingest whatever the spec says.
- Auto-resolve a disagreement with another source.

## What could go wrong, and how you would know

- verification_date is missing from the feed. Every contact becomes undated and must be treated as confidence 1 — which quietly makes the whole feed unusable for outbound. This is why the field is flagged red in the table above and why it should be requested in writing before signature.

- A record is stale. S2 downgrades it automatically at 90 days and it appears in the expired queue.

- SalesIntel disagrees with a rep capture or with existing research. Both are retained with dates and a conflict is raised. Being a paid provider does not make it right.

## If something looks wrong

Every field carries its class, its gate and its reason. Nothing is mapped silently, and unrecognised fields are retained in the raw payload rather than dropped.

---

Full gate definitions, refusal behaviour and acceptance tests: [`INGESTION-GATES.md`](../INGESTION-GATES.md).
