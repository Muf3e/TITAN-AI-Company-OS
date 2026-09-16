const assert = require('assert');
const { policy, recordPayment, tools } = require('../server');

const db = {
  company: { maxSpend: 2000 },
  payments: [], revenue: [], events: [], traces: [], activity: []
};

assert.equal(policy(db, { spend: 500 }).allowed, true);
assert.equal(policy(db, { spend: 2500 }).allowed, false);
assert.equal(policy(db, { external: true }).requiresApproval, true);
assert.equal(recordPayment(db, { amount: 1000, provider: 'test', providerEventId: 'evt_1', verified: false }).status, 400);
const first = recordPayment(db, { amount: 1000, provider: 'test', providerEventId: 'evt_1', verified: true });
assert.equal(first.payment.amount, 1000);
const duplicate = recordPayment(db, { amount: 1000, provider: 'test', providerEventId: 'evt_1', verified: true });
assert.equal(duplicate.duplicate, true);
assert.equal(db.revenue.length, 1);
assert.ok(tools().some(t => t.id === 'payment_record'));
console.log('TITAN runtime smoke tests passed');
