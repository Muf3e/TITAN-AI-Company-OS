const assert = require('assert');

const originalFetch = global.fetch;

async function run() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_titan_fake';
  const { createCheckoutSession } = require('../lib/stripe');

  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(options.method, 'POST');
    assert.match(options.headers.Authorization, /^Bearer sk_test_titan_fake$/);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('mode'), 'payment');
    assert.equal(body.get('line_items[0][price_data][currency]'), 'inr');
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), '1250');
    assert.equal(body.get('metadata[titanOrderId]'), 'ord_test');
    assert.equal(body.get('custom_fields[0][key]'), 'business_name');
    assert.equal(body.get('custom_fields[2][key]'), 'main_goal');
    return { ok: true, json: async () => ({ id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' }) };
  };

  const session = await createCheckoutSession({
    orderId: 'ord_test',
    name: 'TITAN Growth Package',
    description: 'Test offer',
    amount: 1250,
    currency: 'INR',
    successUrl: 'https://example.com/?success=1',
    cancelUrl: 'https://example.com/?cancel=1'
  });

  assert.equal(session.id, 'cs_test');
  assert.equal(session.url, 'https://checkout.stripe.test/cs_test');
  console.log('TITAN Stripe checkout tests passed');
}

run().finally(() => { global.fetch = originalFetch; });
