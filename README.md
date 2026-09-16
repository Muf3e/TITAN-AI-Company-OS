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
- Initial commercial offer: **TITAN AI Automation Audit — ₹999**
- Stripe Checkout Session creation using `STRIPE_SECRET_KEY`
- Stripe Checkout return verification using the server-side secret key
- Checkout intake fields for business name, website, and automation goal
- Paid-order intake persisted for automated fulfillment
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

`STRIPE_SECRET_KEY` enables TITAN to create and server-verify Stripe Checkout Sessions. Keep it server-side; Stripe documents secret API keys as credentials that must not be exposed in client code or public repositories. `STRIPE_WEBHOOK_SECRET` remains the preferred mechanism for asynchronous payment fulfillment because customers are not guaranteed to return to the success page.

## Commerce endpoints

- `GET /api/offers` — returns active commercial offers and self-seeds the initial offer if the production database is empty.
- `POST /api/checkout/stripe` — creates a TITAN order and Stripe Checkout Session from an active offer.
- `GET /api/checkout/verify?session_id=...` — server-verifies a returned Checkout Session and reconciles a paid order.
- `GET /api/stripe/status` — reports whether the Stripe secret key and webhook secret are configured (never returns secrets).
- `POST /api/webhooks/stripe` — accepts signed `payment_intent.succeeded`, `charge.succeeded`, and `checkout.session.completed` events.
- `POST /api/webhooks/razorpay` — accepts signed `payment.captured` events.
- `POST /api/payments` — blocked in the production gateway; payment state must originate from a verified provider flow.

The Stripe Checkout currently asks for three non-sensitive fulfillment inputs: business/brand name, optional website, and the customer's main automation goal. Stripe supports up to three Checkout custom fields and includes their values in the completed Checkout Session/webhook, which lets TITAN carry paid-customer context into its fulfillment engine.

TITAN supports the secret-key return verification path now, while keeping signed webhooks as the durable production fulfillment path.

TITAN does not claim revenue until a verified payment event or server-verified paid Checkout Session is recorded.

Never commit API keys or webhook secrets to GitHub. Configure them as deployment secrets/environment variables.
