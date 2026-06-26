# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
pnpm dlx sv@0.16.1 create --template minimal --types ts --add prettier eslint vitest="usages:unit" tailwindcss="plugins:forms,typography" --install pnpm hack
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## QueueStorm Investigator API

This project exposes two HTTP endpoints:

- `GET /health` → `{"status":"ok"}`
- `POST /analyze-ticket` → structured JSON per the spec in `docs/` (case_type, severity, department, evidence_verdict, agent_summary, recommended_next_action, customer_reply, human_review_required, confidence, reason_codes, …).

The matcher in `src/lib/investigator/matcher.ts` is the deterministic source of truth for `relevant_transaction_id` and `evidence_verdict`.

### Optional: Gemini-powered reasoning

Case classification and the agent/customer text can be refined by Google's Gemini. To enable:

```sh
cp .env.example .env
# edit .env and set GEMINI_API_KEY
pnpm dev
```

With `GEMINI_API_KEY` set, the service calls `gemini-2.5-flash` (override with `GEMINI_MODEL`) using `responseSchema` to pin every enum to the spec. A 20-second timeout protects the per-request SLA; on any error the service falls back to the rule-based pipeline so the API still answers within 30 seconds. The safety filter in `src/lib/investigator/safety.ts` always runs on the final reply, whether it came from Gemini or from the rule-based draft.

Without a key, the service runs fully offline.
