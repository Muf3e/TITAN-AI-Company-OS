const crypto = require('crypto');

function safeEqualHex(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function verifyRazorpay(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature);
}

function parseStripeSignature(header) {
  const parts = String(header || '').split(',');
  const out = { timestamp: null, signatures: [] };
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') out.timestamp = Number(value);
    if (key === 'v1' && value) out.signatures.push(value);
  }
  return out;
}

function verifyStripe(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!secret || !signatureHeader) return false;
  const parsed = parseStripeSignature(signatureHeader);
  if (!Number.isFinite(parsed.timestamp) || !parsed.signatures.length) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - parsed.timestamp);
  if (age > toleranceSeconds) return false;
  const expected = hmacHex(secret, `${parsed.timestamp}.${rawBody}`);
  return parsed.signatures.some(sig => safeEqualHex(expected, sig));
}

module.exports = { verifyRazorpay, verifyStripe, parseStripeSignature };
