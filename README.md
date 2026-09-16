# TITAN — AI Company Operating System

TITAN is a production-oriented AI company runtime designed to turn business outcomes into measurable execution.

## Runtime layers

Founder → CEO → Planner → Specialist Agents → Tools → Policy Gate → Execution → Events → Persistent State → Commerce → Verified Revenue

## Current release

**v0.6.0**

The current runtime includes:

- AI CEO and specialist agent orchestration
- Internal task execution
- Policy and approval gates
- Persistent PostgreSQL state when `DATABASE_URL` is configured
- Local JSON development fallback
- Lead → Offer → Order → Payment → Revenue lifecycle
- Direct/manual payment recording blocked in the production API
- Signed Razorpay and Stripe webhook adapters
- Verified payment events with duplicate protection
- Order state updated after verified payment
- Execution traces and event logging
- Vercel-compatible production gateway
- Smoke tests and GitHub Actions CI

## AI model configuration

The production gateway defaults to `gpt-5.6-luna` when `OPENAI_MODEL` is not explicitly set. This is the cost-efficient high-volume model choice; override `OPENAI_MODEL` when a deployment needs a different compatible provider/model.

## Production requirements

Set these environment variables in the deployment environment:

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6-luna
DATABASE_URL=
DATABASE_SSL=true
RAZORPAY_WEBHOOK_SECRET=
STRIPE_WEBHOOK_SECRET=
```

`DATABASE_URL` is the production persistence gate. Local JSON mode is intended for development only.

Payment endpoints:

- `POST /api/webhooks/razorpay` — accepts signed `payment.captured` events.
- `POST /api/webhooks/stripe` — accepts signed `payment_intent.succeeded` and `charge.succeeded` events.
- `POST /api/payments` — blocked in the production gateway; payment state must originate from a signed provider webhook.

TITAN does not claim revenue until a verified payment event is received from a payment provider.

Never commit API keys or webhook secrets to GitHub. Configure them as deployment secrets/environment variables.
