const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadState, saveState, mode: persistenceMode } = require('./lib/persistence');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT || 4173;
const AI_API_KEY = process.env.OPENAI_API_KEY || '';
const AI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';

const id = prefix => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

function json(res, status, data) {
  const out = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out) });
  res.end(out);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function log(db, text, type = 'system') {
  db.activity ||= [];
  db.activity.unshift({ time: now().slice(0, 16).replace('T', ' '), text, type });
  db.activity = db.activity.slice(0, 200);
}

function trace(db, event, payload = {}) {
  db.traces ||= [];
  db.traces.unshift({ id: id('trace'), time: now(), event, payload });
  db.traces = db.traces.slice(0, 1000);
}

function ensureCollections(db) {
  for (const key of ['leads', 'customers', 'offers', 'orders', 'payments', 'events', 'traces', 'activity']) db[key] ||= [];
}

function context(db) {
  return JSON.stringify({
    company: db.company,
    agents: db.agents,
    projects: db.projects,
    tasks: db.tasks,
    approvals: db.approvals,
    revenue: db.revenue,
    leads: db.leads,
    customers: db.customers,
    offers: db.offers,
    orders: db.orders,
    payments: db.payments
  });
}

async function model(messages) {
  if (!AI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY is not configured', mode: 'local-fallback' };
  try {
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.2 })
    });
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data?.error?.message || `Provider returned ${response.status}`, mode: 'provider' };
    return { ok: true, mode: 'provider', text: data?.choices?.[0]?.message?.content || '', usage: data.usage || null };
  } catch (error) {
    return { ok: false, error: error.message, mode: 'provider' };
  }
}

function tools() {
  return [
    { id: 'company_state', risk: 'read', description: 'Read company operating state.' },
    { id: 'task_create', risk: 'write', description: 'Create internal work.' },
    { id: 'agent_handoff', risk: 'write', description: 'Delegate work between agents.' },
    { id: 'approval_request', risk: 'write', description: 'Request founder approval for consequential actions.' },
    { id: 'lead_create', risk: 'write', description: 'Capture a sales lead.' },
    { id: 'offer_create', risk: 'write', description: 'Create a sellable offer.' },
    { id: 'order_create', risk: 'write', description: 'Create an order before payment.' },
    { id: 'payment_record', risk: 'write', description: 'Record a verified payment event only.' },
    { id: 'revenue_record', risk: 'write', description: 'Record revenue only from a verified payment.' },
    { id: 'trace_log', risk: 'write', description: 'Record execution telemetry.' }
  ];
}

function policy(db, action) {
  const spend = Number(action.spend || 0);
  const maxSpend = Number(db.company?.maxSpend || 0);
  if (spend > maxSpend) return { allowed: false, requiresApproval: true, reason: `Spend ₹${spend.toLocaleString('en-IN')} exceeds autonomous limit ₹${maxSpend.toLocaleString('en-IN')}.` };
  if (action.external) return { allowed: false, requiresApproval: true, reason: 'External side effects require founder approval in co-pilot mode.' };
  return { allowed: true, requiresApproval: false };
}

function localPlan(goal) {
  const g = goal.toLowerCase();
  if (/sell|revenue|customer|order|lead/.test(g)) {
    return [
      ['Define offer, ICP and pricing', 'ceo', 'high'],
      ['Build lead acquisition experiment', 'growth', 'high'],
      ['Design qualification and follow-up workflow', 'sales', 'high'],
      ['Build conversion asset', 'builder', 'medium']
    ];
  }
  return [
    ['Translate outcome into measurable milestones', 'ceo', 'high'],
    ['Research highest-leverage growth experiments', 'growth', 'high'],
    ['Design operating workflow', 'sales', 'medium'],
    ['Build first usable implementation slice', 'builder', 'high']
  ];
}

async function plan(db, goal) {
  if (!AI_API_KEY) return { mode: 'local-fallback', tasks: localPlan(goal).map(([title, agent, priority]) => ({ title, agent, priority })) };
  const result = await model([
    { role: 'system', content: `You are TITAN COO. Return ONLY a JSON array of 3-6 executable internal tasks. Agents allowed: ceo,growth,sales,builder. Schema: {title,agent,priority}. No external claims. State: ${context(db)}` },
    { role: 'user', content: goal }
  ]);
  if (!result.ok) return { mode: 'local-fallback', warning: result.error, tasks: localPlan(goal).map(([title, agent, priority]) => ({ title, agent, priority })) };
  try {
    const parsed = JSON.parse(result.text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim());
    const valid = Array.isArray(parsed) ? parsed.filter(task => task?.title && ['ceo', 'growth', 'sales', 'builder'].includes(task.agent)).slice(0, 6) : [];
    if (!valid.length) throw new Error('No valid tasks');
    return { mode: 'provider', tasks: valid, usage: result.usage };
  } catch (error) {
    return { mode: 'local-fallback', warning: `Planner JSON invalid: ${error.message}`, tasks: localPlan(goal).map(([title, agent, priority]) => ({ title, agent, priority })) };
  }
}

function verifiedPayment(db, payment) {
  return payment.verified === true && Number(payment.amount) > 0 && !!payment.provider && !!payment.providerEventId;
}

function recordPayment(db, paymentInput) {
  if (!verifiedPayment(db, paymentInput)) return { error: 'Payment must be verified and include amount, provider and providerEventId.', status: 400 };
  if (db.payments.some(payment => payment.provider === paymentInput.provider && payment.providerEventId === paymentInput.providerEventId)) {
    return { error: 'Duplicate payment event ignored.', status: 200, duplicate: true };
  }
  const payment = {
    id: id('pay'),
    orderId: paymentInput.orderId || null,
    provider: paymentInput.provider,
    providerEventId: paymentInput.providerEventId,
    amount: Number(paymentInput.amount),
    currency: paymentInput.currency || 'INR',
    verified: true,
    receivedAt: now()
  };
  db.payments.unshift(payment);
  db.revenue.unshift({ id: id('r'), date: now().slice(0, 10), source: `${payment.provider} payment`, amount: payment.amount, paymentId: payment.id, orderId: payment.orderId, verified: true });
  db.events.unshift({ id: id('evt'), type: 'payment.verified', aggregateId: payment.id, time: now(), data: payment });
  trace(db, 'payment.verified', payment);
  log(db, `Verified payment received: ₹${payment.amount.toLocaleString('en-IN')}.`, 'commerce');
  return { payment };
}

async function api(req, res) {
  const db = await loadState();
  ensureCollections(db);
  const url = new URL(req.url, 'http://titan.local');
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'titan-ai-company', version: '0.7.0', persistence: persistenceMode(), ai: { configured: !!AI_API_KEY, model: AI_MODEL, baseUrl: AI_BASE_URL }, productionReady: !!process.env.DATABASE_URL });
    }
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, db);
    if (req.method === 'GET' && pathname === '/api/tools') return json(res, 200, { tools: tools() });
    if (req.method === 'GET' && pathname === '/api/traces') return json(res, 200, { traces: db.traces });

    if (req.method === 'POST' && pathname === '/api/company') {
      const input = await readBody(req);
      db.company = { ...db.company, ...input };
      log(db, 'Founder updated company constitution.');
      await saveState(db);
      return json(res, 200, db.company);
    }

    if (req.method === 'POST' && pathname === '/api/policy/check') {
      const input = await readBody(req);
      const result = policy(db, input);
      trace(db, 'policy.check', { action: input, result });
      await saveState(db);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/orchestrate') {
      const input = await readBody(req);
      const goal = String(input.goal || '').trim();
      if (!goal) return json(res, 400, { error: 'goal required' });
      const planResult = await plan(db, goal);
      const created = [];
      for (const spec of planResult.tasks) {
        const task = { id: id('t'), title: spec.title, agent: spec.agent, status: 'todo', priority: spec.priority || 'medium', project: input.project || 'p1', createdAt: now(), output: null, source: 'orchestrator' };
        db.tasks.unshift(task);
        created.push(task);
      }
      trace(db, 'orchestrator.plan', { goal, taskIds: created.map(task => task.id), mode: planResult.mode });
      log(db, `COO orchestrated ${created.length} tasks for: ${goal.slice(0, 100)}.`, 'ai');
      await saveState(db);
      return json(res, 201, { goal, tasks: created, mode: planResult.mode, warning: planResult.warning || null });
    }

    if (req.method === 'POST' && pathname === '/api/tasks') {
      const input = await readBody(req);
      const task = { id: id('t'), title: input.title || 'Untitled task', agent: input.agent || 'ceo', status: 'todo', priority: input.priority || 'medium', project: input.project || 'p1', createdAt: now(), output: null };
      db.tasks.unshift(task);
      log(db, `Task created: ${task.title}.`);
      await saveState(db);
      return json(res, 201, task);
    }

    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/execute$/.test(pathname)) {
      const taskId = pathname.split('/')[3];
      const task = db.tasks.find(item => item.id === taskId);
      if (!task) return json(res, 404, { error: 'Task not found' });
      const agent = db.agents.find(item => item.id === task.agent) || db.agents.find(item => item.id === 'ceo');
      task.status = 'working';
      if (agent) agent.status = 'working';
      trace(db, 'task.start', { taskId: task.id, agent: task.agent });
      await saveState(db);

      const result = await model([
        { role: 'system', content: `You are ${agent?.name || 'Alex'}, ${agent?.role || 'AI CEO'} in TITAN. Produce a concrete work product. Never claim external actions. State: ${context(db)}` },
        { role: 'user', content: `Execute now: ${task.title}. Return result, assumptions/decisions, next action.` }
      ]);

      task.output = result.ok ? result.text : `Fallback execution: break "${task.title}" into a concrete checklist, deliverable and next measurable action.`;
      task.status = 'done';
      if (agent) agent.status = 'online';
      trace(db, 'task.complete', { taskId: task.id, agent: task.agent, mode: result.ok ? 'provider' : 'local-fallback' });
      log(db, `${agent?.name || 'Agent'} completed: ${task.title}.`, 'ai');
      await saveState(db);
      return json(res, 200, { task, mode: result.ok ? 'provider' : 'local-fallback', warning: result.ok ? null : result.error, usage: result.usage || null });
    }

    if (req.method === 'POST' && pathname === '/api/leads') {
      const input = await readBody(req);
      const lead = { id: id('lead'), name: input.name || 'Unknown', email: input.email || null, source: input.source || 'unknown', status: input.status || 'new', notes: input.notes || '', createdAt: now(), updatedAt: now() };
      db.leads.unshift(lead);
      db.events.unshift({ id: id('evt'), type: 'lead.created', aggregateId: lead.id, time: now(), data: lead });
      await saveState(db);
      return json(res, 201, lead);
    }

    if (req.method === 'PATCH' && /^\/api\/leads\/[^/]+$/.test(pathname)) {
      const input = await readBody(req);
      const lead = db.leads.find(item => item.id === pathname.split('/')[3]);
      if (!lead) return json(res, 404, { error: 'Lead not found' });
      Object.assign(lead, input, { updatedAt: now() });
      await saveState(db);
      return json(res, 200, lead);
    }

    if (req.method === 'POST' && pathname === '/api/offers') {
      const input = await readBody(req);
      const offer = { id: id('offer'), name: input.name || 'Untitled offer', description: input.description || '', price: Number(input.price) || 0, currency: input.currency || 'INR', active: input.active !== false, createdAt: now() };
      db.offers.unshift(offer);
      await saveState(db);
      return json(res, 201, offer);
    }

    if (req.method === 'POST' && pathname === '/api/orders') {
      const input = await readBody(req);
      const offer = db.offers.find(item => item.id === input.offerId);
      if (!offer) return json(res, 404, { error: 'Offer not found' });
      const order = { id: id('ord'), offerId: offer.id, leadId: input.leadId || null, customerId: input.customerId || null, amount: Number(input.amount ?? offer.price), currency: input.currency || offer.currency, status: 'pending_payment', createdAt: now() };
      db.orders.unshift(order);
      db.events.unshift({ id: id('evt'), type: 'order.created', aggregateId: order.id, time: now(), data: order });
      await saveState(db);
      return json(res, 201, order);
    }

    if (req.method === 'POST' && pathname === '/api/payments') {
      return json(res, 403, { error: 'Direct payment recording is disabled. Use the signed provider gateway.' });
    }

    if (req.method === 'POST' && pathname === '/api/revenue') {
      return json(res, 400, { error: 'Manual revenue entry is disabled. Revenue must originate from a verified payment event.' });
    }

    if (req.method === 'POST' && pathname === '/api/ceo') {
      const input = await readBody(req);
      const question = String(input.message || '').trim();
      if (!question) return json(res, 400, { error: 'message required' });
      const result = await model([
        { role: 'system', content: `You are Alex, TITAN AI CEO. Be operational and truthful. Never claim external actions. State: ${context(db)}` },
        { role: 'user', content: question }
      ]);
      log(db, `Founder asked CEO: “${question.slice(0, 100)}”.`, result.ok ? 'ai' : 'local');
      await saveState(db);
      return json(res, 200, { reply: result.ok ? result.text : 'AI provider is not configured. The runtime is ready for provider execution.', mode: result.ok ? 'provider' : 'local-fallback', warning: result.ok ? null : result.error, model: result.ok ? AI_MODEL : null });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error.code === 'STATE_CONFLICT') return json(res, 409, { error: error.message, code: error.code });
    trace(db, 'api.error', { path: pathname, error: error.message });
    try { await saveState(db); } catch (_) {}
    return json(res, 500, { error: error.message });
  }
}

const handler = async (req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC, requested));
  if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
};

if (require.main === module) http.createServer(handler).listen(PORT, () => console.log(`TITAN v0.7 running at http://localhost:${PORT}`));

module.exports = { handler, api, tools, policy, recordPayment };
