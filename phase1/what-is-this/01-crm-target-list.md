# What is this? — Importing your CRM target list

**Path 1 of 5 — CRM target list** · COLDPATH ingestion engine · first-run explainer · gates C1–C9 + G0–G9

---

## What this is

This is where the engine learns who you already work, who owns each account, and — most importantly — **who is already a customer**. You drop in a CSV exported from Salesforce or HubSpot. Nothing is sent anywhere; the file is parsed in your browser.

## Why it exists

Everything else the engine does is enrichment on top of this list. Without it, the engine cannot tell a prospect from a flagship customer, and cannot tell you which accounts you are missing.

## What happens to your data

Every step below is a gate. Each one passes, warns, or refuses — and every refusal is recorded with a reason and lands in a review queue a human can see. The queue is surfaced on the Command dashboard as well as on the Ingest overview, so nothing waits silently on a screen nobody opened.

**C1** — Detect the delimiter and encoding, and confirm against a sample before parsing anything.

**C2** — Find the header row. CRM exports often carry title and summary rows above it.

**C3** — Map your columns to engine fields. Common names are detected automatically; anything unmatched is offered to you rather than guessed.

**C4** — Require an account name. Everything else is enrichment, so a sparse row is still a usable row.

**G4** — Resolve each name to a canonical account. This runs **before** customer suppression — see below.

**C5** — Suppress existing customers, matching against every known alias and subsidiary, not just the exact string.

**C6** — Attach an owner, or route the account to a visible unassigned queue.

**C7** — Reconcile against the EPA RMP registry to produce three lists: matched, CRM-only, and **whitespace**.

**C8** — Flag accounts untouched for 12 months or more. Flagged, not deleted.

## What we will never do with it

- Write anything back to your CRM. There are no write credentials — this is structural, not a setting.
- Delete a suppressed row. Suppressed accounts are retained and listed so you can audit every suppression.
- Guess a column mapping. Unmapped columns are shown to you and left alone.
- Send the file anywhere. Parsing happens in your browser.

## What could go wrong, and how you would know

- A customer slips through suppression. This is the highest-consequence failure available. It is why G4 runs first, and why the suppression list is shown in full with every alias that matched.

- A row fails to parse. You get the row number and the reason; the rest of the file still imports.

- Two CRM accounts resolve to the same canonical entity. Both are shown with their scores and you choose.

## If something looks wrong

Every refusal, ambiguity and suppression appears in the review queue with the reason attached. Nothing disappears.

---

Full gate definitions, refusal behaviour and acceptance tests: [`INGESTION-GATES.md`](../INGESTION-GATES.md).
