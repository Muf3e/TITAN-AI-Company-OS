const STRIPE_API = 'https://api.stripe.com/v1';

function requireSecret() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (!/^sk_(test|live)_/.test(key)) throw new Error('STRIPE_SECRET_KEY does not look like a Stripe secret API key');
  return key;
}

async function stripeRequest(path, params) {
  const key = requireSecret();
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) body.set(k, String(v));
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Stripe API returned ${response.status}`);
  return data;
}

async function stripeGet(path) {
  const key = requireSecret();
  const response = await fetch(`${STRIPE_API}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Stripe API returned ${response.status}`);
  return data;
}

async function createCheckoutSession({ orderId, name, description, amount, currency = 'inr', successUrl, cancelUrl, customerEmail = null }) {
  const numericAmount = Number(amount);
  if (!Number.isInteger(numericAmount) || numericAmount <= 0) throw new Error('Checkout amount must be a positive integer in the smallest currency unit');
  if (!successUrl || !cancelUrl) throw new Error('Checkout successUrl and cancelUrl are required');
  if (!orderId) throw new Error('Checkout orderId is required');

  const params = {
    mode: 'payment',
    'line_items[0][price_data][currency]': String(currency).toLowerCase(),
    'line_items[0][price_data][product_data][name]': String(name || 'TITAN Offer').slice(0, 500),
    'line_items[0][price_data][product_data][description]': String(description || '').slice(0, 500),
    'line_items[0][price_data][unit_amount]': numericAmount,
    'line_items[0][quantity]': 1,
    success_url: String(successUrl),
    cancel_url: String(cancelUrl),
    'metadata[titanOrderId]': orderId
  };
  if (customerEmail) params.customer_email = String(customerEmail).slice(0, 500);
  return stripeRequest('/checkout/sessions', params);
}

async function retrieveCheckoutSession(sessionId) {
  if (!/^cs_(test_)?[A-Za-z0-9_]+/.test(String(sessionId || ''))) throw new Error('Invalid Stripe Checkout Session id');
  return stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

async function retrieveEvent(eventId) {
  if (!/^evt_[A-Za-z0-9_]+/.test(String(eventId || ''))) throw new Error('Invalid Stripe event id');
  return stripeGet(`/events/${encodeURIComponent(eventId)}`);
}

module.exports = { createCheckoutSession, retrieveCheckoutSession, retrieveEvent };
