# TITAN — AI Company Operating System

TITAN is a production-oriented AI company runtime designed to turn business outcomes into measurable execution.

## Runtime layers

Founder → CEO → Planner → Specialist Agents → Tools → Policy Gate → Execution → Events → Persistent State → Commerce → Verified Revenue

## Current release

**v0.5.0**

The current runtime includes:

- AI CEO and specialist agent orchestration
- Internal task execution
- Policy and approval gates
- Persistent PostgreSQL state when `DATABASE_URL` is configured
- Local JSON development fallback
- Lead → Offer → Order → Payment → Revenue lifecycle
- Verified payment events with duplicate protection
- Execution traces and event logging
- Vercel-compatible API entrypoint
- Smoke tests and GitHub Actions CI

## Production requirements

Set these environment variables in the deployment environment:

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5-mini
DATABASE_URL=
DATABASE_SSL=true
```

`DATABASE_URL` is the production persistence gate. Local JSON mode is intended for development only.

TITAN does not claim revenue until a verified payment event is received from a payment provider.
