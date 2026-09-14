# Covering email — COLDPATH prototype

Two versions. The first goes to your main contact; the second is short enough for them to forward to the sales team without editing.

Personalisation notes are at the bottom.

---

## Email 1 — to your main contact

**Subject:** COLDPATH prototype — attached, no install needed

**Attachment:** `COLDPATH-prototype.zip` (169 KB)

---

Hi [Name],

Attached is the working prototype we discussed. Unzip it and **double-click `index.html`** — it runs in any browser, needs no installation, and doesn't connect to anything. Nothing you do in it leaves your machine.

**Two sign-in codes:**

- **9876** — marketing. Opens the whole engine.
- **5432** — sales. Opens the Rep Library only, then asks who's signing in so anything captured stays attributed to a real person.

Worth saying plainly: those codes are a prototype convenience, not security. Both are visible in the page source. The production build signs people in through your own Google Workspace or Entra ID and enforces permissions on the server.

**Start with the tour** — it begins automatically, or click *Take the tour* in the top bar. Nineteen steps, about two minutes, and it covers every screen.

If you only have five minutes, look at these three:

1. **Build List → the EPA RMP panel.** Not sample data. Any US facility holding more than 10,000 lb of anhydrous ammonia has to file a Risk Management Plan with the EPA, and those filings are public. That makes the registry a free, near-complete map of the cold-chain market: **1,382 facilities, resolved into 117 accounts across 755 sites in 43 states.** The CSV of those accounts is in the zip and is yours to keep either way.

2. **Ingest → CRM Target List → "Load a sample export."** The sample has faults planted in it deliberately. Watch eleven validation gates respond — including two existing customers being suppressed even though they're filed under different legal names than the ones on your customer list.

3. **Account Intelligence → The Kroger Co. → Signals.** A real account, researched from public sources: the May DOJ/EPA settlement, the $100M / 600-unit refrigeration obligation, and a new Chief Store Operations Officer starting into it. Every figure carries its source.

**What's real and what isn't** — `README-FIRST.md` in the zip has the full list, but in short: the research, the EPA data, the CSV parsing and the validation gates genuinely run in your browser — 49 are specified, and 39 of them report live across the five ingestion paths. The AI calls are baked in so the file works without an API key, and nothing saves to a database.

Two things I'd rather you found in the prototype than in production, both documented in the README: an early version of the name matcher silently deleted a real prospect because it looked four characters away from an existing customer's name, and the EPA data contains one facility declaring 89 million pounds of ammonia — a marine terminal — which the validation gate now catches. Both are regression tests.

Please break it. Anything that's confusing, wrong, or missing is much cheaper to fix this week than in month two.

[Your name]

---

## Email 2 — short version for forwarding to the team

**Subject:** COLDPATH prototype — 2 minutes, no install

---

Team,

Attached is the prototype of the account research engine. Unzip, **double-click `index.html`**, no install, no internet needed.

**Sales code: 5432.** It opens the Rep Library — pick your name when asked so anything you capture is attributed to you. (Marketing code is 9876; that side opens the whole engine.)

The tour starts automatically and takes about two minutes. The bit worth your time is **Account Intelligence → The Kroger Co.** — a real account brief built from public sources, including the DOJ/EPA refrigeration settlement and who starts in the Chief Store Operations seat.

Two codes are not security, so don't put anything sensitive in it. It's a prototype with baked-in data.

If a brief is wrong, thin, or missing something you'd need before a call — tell me. That feedback is the entire point of sending it now rather than later.

[Your name]

---

## Personalisation notes

**Swap these before sending:**

| Placeholder | Note |
|---|---|
| `[Name]` | Recipient |
| `[Your name]` | You |
| Marketing owner in Email 2 | The prototype's marketing user is **Madeline Belvin**. If that isn't a real person at Ndustrial, tell me and I'll rename her in the app before you send it — she appears in 27 places including account ownership and deliverable bylines. |

**Two numbers to double-check if you edit:** the prototype currently reports **117 accounts / 755 sites**. If you regenerate the EPA pull before sending, those figures move — the README and the in-app panel both read from the same data, but the email body is hardcoded.

**Don't promise the whitespace number.** The demo's "106 accounts not in your CRM" comes from the *sample* CSV, not theirs. If they ask, the honest answer is: run your real export through it and that number becomes meaningful — which is a good reason to ask for the export.

**If they have IT/security involvement,** add one line: *"Happy to walk your IT team through where data would live in production — the short version is your own infrastructure, with Postgres as the only stateful dependency."* It pre-empts the third-party-SaaS objection before it forms.

**Attachment blocked?** Some corporate gateways quarantine `.zip` too. Fallbacks in order: share via their SharePoint or OneDrive, your Drive with a view link, or send `index.html` on its own (it works standalone — the CSVs and README are extras, not dependencies).
