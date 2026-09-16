// Production default: use the current cost-efficient GPT-5.6 model unless deployment config overrides it.
if (!process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = 'gpt-5.6-luna';

const crypto = require('crypto');
const { handler, recordPayment } = require('../server');
const { loadState, saveState } = require('../lib/persistence');
const { verifyRazorpay, verifyStripe } = require('../lib/webhooks');
const { createCheckoutSession, retrieveCheckoutSession } = require('../lib/stripe');

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error('Webhook payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const out = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
  res.end(out);
}

function ensureCollections(db) {
  for (const key of ['payments', 'revenue', 'events', 'traces', 'activity', 'orders', 'offers']) db[key] ||= [];
}

function defaultOffer() {
  return {
    id: 'offer_ai_audit',
    name: 'TITAN AI Automation Audit',
    description: 'A practical AI automation blueprint that identifies repetitive work, automation opportunities, recommended tools, and a prioritized 30-day implementation plan.',
    price: 999,
    currency: 'INR',
    active: true,
    createdAt: new Date().toISOString()
  };
}

function markOrderPaid(db, orderId, payment) {
  if (!orderId) return;
  const order = db.orders.find(x => x.id === orderId);
  if (!order) return;
  order.status = 'paid';
  order.paidAt = payment.receivedAt;
  order.paymentId = payment.id;
}

function minorUnitAmount(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Offer price must be greater than zero');
  const zeroDecimal = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  return Math.round(value * (zeroDecimal.has(String(currency).toLowerCase()) ? 1 : 100));
}

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const host = req.headers.host;
  if (!host) throw new Error('Unable to determine application host');
  return `${protocol}://${host}`;
}

async function listOffers(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });
  const db = await loadState();
  ensureCollections(db);
  if (!db.offers.length) {
    db.offers.push(defaultOffer());
    db.activity ||= [];
    db.activity.unshift({ time: new Date().toISOString().slice(0, 16).replace('T', ' '), text: 'Commercial seed offer published: TITAN AI Automation Audit — ₹999.' });
    await saveState(db);
  }
  return send(res, 200, { offers: db.offers.filter(x => x.active !== false) });
}

async function createCheckout(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: 'Stripe checkout is not configured. STRIPE_SECRET_KEY is missing.' });

  let body;
  try { body = await rawBody(req); body = body ? JSON.parse(body) : {}; } catch (_) { return send(res, 400, { error: 'Invalid JSON' }); }

  const db = await loadState();
  ensureCollections(db);
  if (!db.offers.length) db.offers.push(defaultOffer());
  const offer = db.offers.find(x => x.id === body.offerId && x.active !== false);
  if (!offer) return send(res, 404, { error: 'Active offer not found' });

  const order = {
    id: `ord_${crypto.randomBytes(5).toString('hex')}`,
    offerId: offer.id,
    leadId: body.leadId || null,
    customerId: body.customerId || null,
    amount: Number(offer.price),
    currency: String(offer.currency || 'INR').toUpperCase(),
    status: 'creating_checkout',
    createdAt: new Date().toISOString()
  };
  db.orders.unshift(order);
  db.events.unshift({ id: `evt_${Date.now().toString(36)}`, type: 'order.created', aggregateId: order.id, time: new Date().toISOString(), data: order });
  await saveState(db);

  try {
    const base = requestBaseUrl(req);
    const session = await createCheckoutSession({
      orderId: order.id,
      name: offer.name,
      description: offer.description,
      amount: minorUnitAmount(offer.price, offer.currency),
      currency: offer.currency,
      successUrl: `${base}/?checkout=success&order=${encodeURIComponent(order.id)}&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/?checkout=cancelled&order=${encodeURIComponent(order.id)}`,
      customerEmail: body.email || null
    });
    order.status = 'awaiting_payment';
    order.checkoutProvider = 'stripe';
    order.checkoutSessionId = session.id;
    order.checkoutUrl = session.url;
    order.updatedAt = new Date().toISOString();
    db.events.unshift({ id: `evt_${Date.now().toString(36)}`, type: 'checkout.created', aggregateId: order.id, time: new Date().toISOString(), data: { provider: 'stripe', sessionId: session.id } });
    await saveState(db);
    return send(res, 201, { order, checkoutUrl: session.url, provider: 'stripe' });
  } catch (error) {
    order.status = 'checkout_failed';
    order.checkoutError = error.message;
    order.updatedAt = new Date().toISOString();
    await saveState(db);
    return send(res, 502, { error: 'Stripe checkout creation failed', detail: error.message, orderId: order.id });
  }
}

async function verifyCheckoutReturn(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET required' });
  const url = new URL(req.url, 'http://titan.local');
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return send(res, 400, { error: 'session_id is required' });
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: 'Stripe checkout is not configured' });

  try {
    const session = await retrieveCheckoutSession(sessionId);
    const orderId = session.metadata?.titanOrderId || null;
    const db = await loadState();
    ensureCollections(db);
    const order = orderId ? db.orders.find(x => x.id === orderId) : null;
    if (!order || order.checkoutSessionId !== session.id) return send(res, 404, { error: 'TITAN order could not be reconciled to this Checkout Session' });

    if (session.payment_status !== 'paid') return send(res, 200, { verified: false, paymentStatus: session.payment_status, order });

    const providerEventId = `checkout:${session.id}`;
    const existing = db.payments.find(p => p.provider === 'stripe' && p.providerEventId === providerEventId);
    if (existing) return send(res, 200, { verified: true, duplicate: true, payment: existing, order });

    const payment = {
      orderId: order.id,
      provider: 'stripe',
      providerEventId,
      amount: Number(session.amount_total || 0) / 100,
      currency: String(session.currency || order.currency || 'INR').toUpperCase(),
      verified: true
    };
    const result = recordPayment(db, payment);
    if (result.error) return send(res, result.status || 400, { error: result.error });
    if (result.payment) {
      markOrderPaid(db, order.id, result.payment);
      db.events.unshift({ id: `evt_${Date.now().toString(36)}`, type: 'stripe.checkout.verified', aggregateId: result.payment.id, time: new Date().toISOString(), data: { sessionId: session.id } });
      await saveState(db);
    }
    return send(res, 200, { verified: true, duplicate: !!result.duplicate, payment: result.payment, order });
  } catch (error) {
    return send(res, 502, { error: 'Stripe Checkout verification failed', detail: error.message });
  }
}

async function paymentWebhook(req, res, provider) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  const raw = await rawBody(req);
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return send(res, 400, { error: 'Invalid JSON' }); }

  const secret = provider === 'razorpay' ? process.env.RAZORPAY_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
  const signature = provider === 'razorpay' ? req.headers['x-razorpay-signature'] : req.headers['stripe-signature'];
  if (!secret) return send(res, 503, { error: `${provider} webhook secret is not configured` });
  const valid = provider === 'razorpay' ? verifyRazorpay(raw, signature, secret) : verifyStripe(raw, signature, secret);
  if (!valid) return send(res, 401, { error: 'Invalid webhook signature' });

  const db = await loadState();
  ensureCollections(db);
  let eventType;
  let eventId;
  let payment;

  if (provider === 'razorpay') {
    eventType = payload.event || '';
    eventId = payload.payload?.payment?.entity?.id || payload.id;
    const entity = payload.payload?.payment?.entity;
    if (eventType !== 'payment.captured' || !entity) return send(res, 200, { received: true, ignored: true, reason: 'unsupported_event' });
    payment = { orderId: entity.order_id || null, provider: 'razorpay', providerEventId: eventId, amount: Number(entity.amount) / 100, currency: String(entity.currency || 'INR').toUpperCase(), verified: true };
  } else {
    eventType = payload.type || '';
    eventId = payload.id;
    const entity = payload.data?.object;
    if (!['payment_intent.succeeded', 'charge.succeeded', 'checkout.session.completed'].includes(eventType) || !entity) return send(res, 200, { received: true, ignored: true, reason: 'unsupported_event' });
    const amount = Number(entity.amount_received ?? entity.amount_total ?? entity.amount ?? 0);
    payment = { orderId: entity.metadata?.titanOrderId || entity.client_reference_id || null, provider: 'stripe', providerEventId: eventId, amount: amount / 100, currency: String(entity.currency || 'usd').toUpperCase(), verified: true };
  }

  if (!eventId || !payment.amount || payment.amount <= 0) return send(res, 400, { error: 'Verified webhook did not contain a valid payment amount or event id' });
  const result = recordPayment(db, payment);
  if (result.error) return send(res, result.status || 400, { error: result.error });
  if (result.payment) {
    markOrderPaid(db, payment.orderId, result.payment);
    db.events.unshift({ id: `evt_${Date.now().toString(36)}`, type: `${provider}.${eventType}`, aggregateId: result.payment.id, time: new Date().toISOString(), data: { providerEventId: eventId } });
    await saveState(db);
  }
  return send(res, 200, { received: true, duplicate: !!result.duplicate, payment: result.payment || null });
}

async function gateway(req, res) {
  const url = new URL(req.url, 'http://titan.local');
  if (url.pathname === '/api/webhooks/razorpay') return paymentWebhook(req, res, 'razorpay');
  if (url.pathname === '/api/webhooks/stripe') return paymentWebhook(req, res, 'stripe');
  if (url.pathname === '/api/checkout/stripe') return createCheckout(req, res);
  if (url.pathname === '/api/checkout/verify') return verifyCheckoutReturn(req, res);
  if (url.pathname === '/api/offers') return listOffers(req, res);
  if (url.pathname === '/api/stripe/status' && req.method === 'GET') {
    return send(res, 200, { configured: !!process.env.STRIPE_SECRET_KEY, webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET, mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_') ? 'live' : process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ? 'test' : 'unconfigured' });
  }
  if (url.pathname === '/api/payments' && req.method === 'POST') return send(res, 403, { error: 'Direct payment recording is disabled. Use a signed payment-provider webhook.' });
  return handler(req, res);
}

module.exports = gateway;
