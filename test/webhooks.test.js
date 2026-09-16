const assert = require('assert');
const crypto = require('crypto');
const { verifyRazorpay, verifyStripe } = require('../lib/webhooks');

const secret = 'titan-test-secret';
const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_123', amount: 125000 } } } });
const razorSig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
assert.equal(verifyRazorpay(raw, razorSig, secret), true);
assert.equal(verifyRazorpay(raw + 'tampered', razorSig, secret), false);

const timestamp = Math.floor(Date.now() / 1000);
const stripeRaw = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded' });
const stripeSig = crypto.createHmac('sha256', secret).update(`${timestamp}.${stripeRaw}`).digest('hex');
assert.equal(verifyStripe(stripeRaw, `t=${timestamp},v1=${stripeSig}`, secret), true);
assert.equal(verifyStripe(stripeRaw, `t=${timestamp},v1=bad`, secret), false);
assert.equal(verifyStripe(stripeRaw, `t=${timestamp - 1000},v1=${stripeSig}`, secret), false);

console.log('TITAN webhook signature tests passed');
