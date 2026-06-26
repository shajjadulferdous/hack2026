# QueueStorm Investigator

An internal copilot for support agents at a Bangladesh digital-finance platform.
Given a customer complaint and a short window of recent transactions, the
service produces a structured triage packet so an agent can resolve the ticket
in one pass:

- what **kind** of case it is (`case_type`)
- which **transaction** in the customer's history is relevant
- whether the data **supports** the customer's claim (`evidence_verdict`)
- how **urgent** it is (`severity`) and which team should pick it up (`department`)
- a one-line **agent summary**, a recommended **next action**, and a safe
  **customer reply**
- whether the ticket should be **escalated to a human** (`human_review_required`)
- a `confidence` score and `reason_codes` explaining the decision

Built for the SUST CSE Carnival 2026 / Codex Community Hackathon online
preliminary.

## How it works

Two stages:

1. **Deterministic matcher** (`src/lib/investigator/matcher.ts`) — picks the
   single transaction from `transaction_history` that the complaint most
   plausibly refers to (amount, counterparty digits, time-of-day clues,
   duplicate-pattern detection, status hints). It never asks the model to
   invent a transaction id.

2. **LLM investigator** (`src/lib/investigator/llm.ts` + `classifier.ts`) —
   when `GEMINI_API_KEY` is set, calls Gemini (`gemini-2.5-flash` by default,
   override with `GEMINI_MODEL`) and lets the model be the single source of
   truth for every other field. The response is pinned with `responseSchema`
   so enums can't drift. A safety filter (`safety.ts`) runs on the model's
   output to strip prompt injection and lock down the customer reply.

If the API key is missing or the LLM call fails (quota, timeout, network),
the service returns an honest `llm_unavailable` / `llm_quota_hit` packet
with `human_review_required: true` instead of guessing from regexes — the
point is that a human agent owns anything the model couldn't process.

## API

Two endpoints:

- `GET  /health` → `{"status":"ok"}`
- `POST /analyze-ticket` → the full triage packet

`POST /analyze-ticket` body:

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to a wrong number around 2pm today. The number was supposed to be 01712345678 but I think I typed it wrong.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "campaign_context": "boishakh_bonanza_day_1",
  "transaction_history": [
    { "transaction_id": "TXN-9101", "timestamp": "2026-04-14T14:08:22Z", "type": "transfer", "amount": 5000, "counterparty": "+8801719876543", "status": "completed" }
  ]
}
```

Response (truncated):

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer mistakenly sent 5000 BDT to an incorrect recipient...",
  "recommended_next_action": "Initiate an investigation for the wrong transfer (TXN-9101)...",
  "customer_reply": "We understand you're concerned about a recent transfer...",
  "human_review_required": true,
  "confidence": 0.9,
  "reason_codes": ["llm", "wrong_transfer", "consistent"]
}
```

The browser dashboard at `/` lets you paste a complaint + transaction history
and inspect the live verdict, reasoning, and the customer reply the model
generated.

## Local development

Requires Node 20+ and pnpm.

```sh
pnpm install
cp .env.example .env.local       # then edit .env.local
pnpm dev                         # http://localhost:5173
```

`.env.local` keys:

| Key              | Default              | Notes                                            |
| ---------------- | -------------------- | ------------------------------------------------ |
| `GEMINI_API_KEY` | _(required for LLM)_ | Without it, every request returns `llm_unavailable`. |
| `GEMINI_MODEL`   | `gemini-2.5-flash`   | Any Gemini model name.                           |

Try it:

```sh
curl http://localhost:5173/health
curl -X POST http://localhost:5173/analyze-ticket \
  -H 'content-type: application/json' \
  -d @sample-ticket.json
```

The request file `SUST_Preli_Sample_Cases.json` in the repo root is the
official prelim sample case pack — feed it through the dashboard or `curl`
loop to sanity-check the model.

## Production build

```sh
pnpm build      # produces build/ and .svelte-kit/output/
pnpm preview    # serves the production build locally
```

Other useful scripts:

```sh
pnpm check        # svelte-check — type and a11y errors
pnpm lint         # prettier --check + eslint
pnpm format       # prettier --write
pnpm test:unit    # vitest
```

## Project layout

```
src/
├── routes/
│   ├── +layout.svelte         # shared chrome + Tailwind import
│   ├── +page.svelte           # the investigator dashboard
│   ├── health/+server.ts      # GET /health
│   └── analyze-ticket/        # POST /analyze-ticket
│       └── +server.ts
└── lib/
    └── investigator/
        ├── classifier.ts      # orchestrator (matcher → LLM, quota handling)
        ├── matcher.ts         # deterministic transaction picker
        ├── llm.ts             # Gemini call + system prompt + response schema
        ├── safety.ts          # post-hoc reply/action hardening
        └── types.ts           # AnalyzeRequest / AnalyzeResponse / enums
```
