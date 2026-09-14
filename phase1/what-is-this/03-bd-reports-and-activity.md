# What is this? — Importing your past research and BD activity

**Path 3 of 5 — BD reports & activity records** · COLDPATH ingestion engine · first-run explainer · gates R1–R10 + G0–G9

---

## What this is

Drop in the documents you already have — the account dossiers marketing wrote, the call notes, the meeting summaries, the win/loss records. They usually arrive mixed together, sometimes inside the same file.

## Why it exists

You have years of accumulated knowledge that currently lives in folders and inboxes. Ingesting it means the engine stops recommending a play you already tried, and stops re-researching what you already know.

## What happens to your data

Every step below is a gate. Each one passes, warns, or refuses — and every refusal is recorded with a reason and lands in a review queue a human can see. The queue is surfaced on the Command dashboard as well as on the Ingest overview, so nothing waits silently on a screen nobody opened.

**R1** — Extract the text. Scanned PDFs with no text layer are refused with a clear reason rather than ingested as empty documents.

**R2** — Classify each document — and each section within long documents — as prior research, an activity record, mixed, or **unclassifiable**.

**R3** — Find the author and the date. A document with no date can never support a current-tense claim.

**R4** — Check currency. Prior research older than twelve months becomes historical context, cited as "as of <date>" everywhere it appears.

**R5** — Cap it at confidence 2. Your own research is often excellent — but the engine cannot verify it, and confidence measures traceability, not quality.

**R6** — Compare against current machine research. Where they disagree, **both are kept**. That disagreement is usually the most valuable thing in the document: it shows what changed.

**R9** — Index activity records so a recommended play already attempted and rejected is suppressed or annotated.

## What we will never do with it

- Turn a claim in an internal document into a level-3 fact. The only route to level 3 is an independent external source.
- Guess a classification. Unclassifiable goes to a human sorting queue.
- Delete or resolve a contradiction. Both versions stay, with dates.
- Let style mining create facts. Voice extraction runs on a structurally separate track.

## What could go wrong, and how you would know

- An old brief is treated as current. R4 and R5 exist precisely to prevent this — a confident 2024 document that is wrong about everything is the easiest way to poison the system.

- Activity notes are misread as research. Misclassifying chatter into the fact store is worse than losing insight, so ties break toward the human queue.

- A play is recommended that already failed. R9 catches it — and if it slips through, marking it wrong suppresses it permanently.

## If something looks wrong

Classification is shown with its score and margin. If it is wrong, re-sort it in one click and the engine learns your filing conventions.

---

Full gate definitions, refusal behaviour and acceptance tests: [`INGESTION-GATES.md`](../INGESTION-GATES.md).
