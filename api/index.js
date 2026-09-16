// Production default: use the current cost-efficient GPT-5.6 model unless deployment config overrides it.
if (!process.env.OPENAI_MODEL) process.env.OPENAI_MODEL = 'gpt-5.6-luna';

const { handler, recordPayment } = require('../server');
const { loadState, saveState } = require('../lib/persistence');
const { verifyRazorpay, verifyStripe } = require('../lib/webhooks');

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
  for (const key of ['payments', 'revenue', 'events', 'traces', 'activity', 'orders']) db[key] ||= [];
}

function markOrderPaid(db, orderId, payment) {
  if (!orderId) return;
  const order = db.orders.find(x => x.id === orderId);
  if (!order) return;
  order.status = 'paid';
  order.paidAt = payment.receivedAt;
  order.paymentId = payment.id;
}

async function paymentWebhook(req, res, provider) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
  const raw = await rawBody(req);
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return send(res, 400, { error: 'Invalid JSON' }); }

  const secret = provider === 'razorpay' ? process.env.RAZORPAY_WEBHOOK_SECRET : process.env.STRIPE_WEBHOOK_SECRET;
  const signature = provider === 'razorpay' ? req.headers['x-razorpay-signature'] : req.headers['stripe-signature'];
  if (!secret) return send(res, 503, { error: `${provider} webhook secret is not configured` });
  const valid = provider === 'razorpay'
    ? verifyRazorpay(raw, signature, secret)
    : verifyStripe(raw, signature, secret);
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
    payment = {
      orderId: entity.order_id || null,
      provider: 'razorpay',
      providerEventId: eventId,
      amount: Number(entity.amount) / 100,
      currency: String(entity.currency || 'INR').toUpperCase(),
      verified: true
    };
  } else {
    eventType = payload.type || '';
    eventId = payload.id;
    const entity = payload.data?.object;
    if (!['payment_intent.succeeded', 'charge.succeeded'].includes(eventType) || !entity) {
      return send(res, 200, { received: true, ignored: true, reason: 'unsupported_event' });
    }
    const amount = Number(entity.amount_received ?? entity.amount ?? 0);
    payment = {
      orderId: entity.metadata?.titanOrderId || null,
      provider: 'stripe',
      providerEventId: eventId,
      amount: amount / 100,
      currency: String(entity.currency || 'usd').toUpperCase(),
      verified: true
    };
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
  if (url.pathname === '/api/payments' && req.method === 'POST') {
    return send(res, 403, { error: 'Direct payment recording is disabled. Use a signed payment-provider webhook.' });
  }
  return handler(req, res);
}

module.exports = gateway;
