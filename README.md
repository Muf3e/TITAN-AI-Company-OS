# TITAN — AI Company Operating System

TITAN is a production-oriented AI company runtime designed to turn business outcomes into measurable execution.

## Runtime layers

Founder → CEO → Planner → Specialist Agents → Tools → Policy Gate → Execution → Events → Persistent State → Commerce → Verified Revenue

## Current release

**v0.7.0**

The current runtime includes:

- AI CEO and specialist agent orchestration
- Internal task execution
- Policy and approval gates
- Persistent PostgreSQL state when `DATABASE_URL` is configured
- Local JSON development fallback
- Lead → Offer → Order → Checkout → Payment → Revenue lifecycle
- Stripe Checkout Session creation using `STRIPE_SECRET_KEY`
- Direct/manual payment recording blocked in the production API
- Signed Razorpay and Stripe webhook adapters
- Verified payment events with duplicate protection
- Order state updated after verified payment
- Execution traces and event logging
- Vercel-compatible production gateway
- Smoke tests and GitHub Actions CI

## AI model configuration

The production gateway defaults to `gpt-5.6-luna` when `OPENAI_MODEL` is not explicitly set. Override `OPENAI_MODEL` when a deployment needs a different compatible provider/model.

## Production requirements

Set these environment variables in the deployment environment:

```text
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6-luna
DATABASE_URL=
DATABASE_SSL=true
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

`DATABASE_URL` is the production persistence gate. Local JSON mode is intended for development only.

`STRIPE_SECRET_KEY` enables TITAN to create Stripe Checkout Sessions. The webhook signing secret is separate: `STRIPE_WEBHOOK_SECRET` is used to authenticate Stripe webhook deliveries. TITAN intentionally does not treat a caller-provided `verified` flag as proof of payment.

## Commerce endpoints

- `POST /api/checkout/stripe` — creates a TITAN order and Stripe Checkout Session from an active offer.
- `GET /api/stripe/status` — reports whether the Stripe secret key and webhook secret are configured (never returns secrets).
- `POST /api/webhooks/stripe` — accepts signed `payment_intent.succeeded`, `charge.succeeded`, and `checkout.session.completed` events.
- `POST /api/webhooks/razorpay` — accepts signed `payment.captured` events.
- `POST /api/payments` — blocked in the production gateway; payment state must originate from a verified provider webhook.

For Stripe, the Checkout Session carries `metadata[titanOrderId]`, allowing a successful payment event to be reconciled to the TITAN order. Stripe's API supports retrieving events with a secret API key, but TITAN still prefers webhook-signature verification for inbound webhook authenticity.

TITAN does not claim revenue until a verified payment event is received from a payment provider.

Never commit API keys or webhook secrets to GitHub. Configure them as deployment secrets/environment variables.
