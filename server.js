// Biesca — WhatsApp OTP login backend
// Sends OTP via AiSensy, verifies it, and saves the customer in Shopify.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const env = process.env;
const PORT = Number(env.PORT || 3005);
const OTP_LENGTH = Number(env.OTP_LENGTH || 6);
const OTP_EXPIRY_MS = Number(env.OTP_EXPIRY_MINUTES || 5) * 60 * 1000;
const OTP_MAX_ATTEMPTS = Number(env.OTP_MAX_ATTEMPTS || 5);
const RESEND_GAP_MS = 30 * 1000;           // min gap between two OTPs to same number
const MAX_SENDS_PER_HOUR = 5;              // per phone
const MAX_SENDS_PER_IP_HOUR = 20;          // per IP
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // verified session: 30 days

if (!env.TOKEN_SECRET || env.TOKEN_SECRET === 'change_me') {
  console.error('Set TOKEN_SECRET in .env first');
  process.exit(1);
}

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));
const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)) }));

// ---------- in-memory stores (fine for a single VPS process) ----------
const otps = new Map();      // phone -> { hash, expires, attempts, lastSent }
const sendLog = new Map();   // key -> [timestamps]

function rateOk(key, limit, windowMs = 3600_000) {
  const now = Date.now();
  const list = (sendLog.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= limit) { sendLog.set(key, list); return false; }
  list.push(now); sendLog.set(key, list); return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otps) if (v.expires < now) otps.delete(k);
  for (const [k, v] of sendLog) if (!v.some(t => now - t < 3600_000)) sendLog.delete(k);
}, 60_000).unref();

// ---------- helpers ----------
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = (env.DEFAULT_COUNTRY_CODE || '91') + d;
  if (d.length === 11 && d.startsWith('0')) d = (env.DEFAULT_COUNTRY_CODE || '91') + d.slice(1);
  if (d.length < 11 || d.length > 15) return null;
  if (d.startsWith('91') && !/^91[6-9]\d{9}$/.test(d)) return null; // valid Indian mobile
  return d; // e.g. 919876543210
}
const hashOtp = (phone, otp) =>
  crypto.createHmac('sha256', env.TOKEN_SECRET).update(`${phone}:${otp}`).digest('hex');
function genOtp() {
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, '0');
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', env.TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', env.TOKEN_SECRET).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ---------- AiSensy ----------
async function sendWhatsAppOtp(phone, otp, name) {
  const body = {
    apiKey: env.AISENSY_API_KEY,
    campaignName: env.AISENSY_CAMPAIGN_NAME,
    destination: phone,
    userName: name || 'Biesca Customer',
    source: 'biesca-otp-login',
    templateParams: [otp],
  };
  if (String(env.AISENSY_OTP_BUTTON) === 'true') {
    body.buttons = [{ type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: otp }] }];
  }
  const r = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`AiSensy ${r.status}: ${text}`);
  return text;
}

// ---------- Shopify ----------
async function shopifyGql(query, variables) {
  const r = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/api/${env.SHOPIFY_API_VERSION || '2025-07'}/graphql.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify({ query, variables }),
    }
  );
  const j = await r.json();
  if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors));
  return j.data;
}

async function upsertCustomer(phone, name, optIn) {
  if (!env.SHOPIFY_ADMIN_TOKEN) return null;
  const e164 = '+' + phone;
  const found = await shopifyGql(
    `query($q:String!){ customers(first:1, query:$q){ nodes{ id tags } } }`,
    { q: `phone:${e164}` }
  );
  const tags = ['otp-login'];
  if (optIn) tags.push('whatsapp-optin');
  const existing = found.customers.nodes[0];
  if (existing) {
    await shopifyGql(
      `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`,
      { id: existing.id, tags }
    );
    return existing.id;
  }
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
  const created = await shopifyGql(
    `mutation($input:CustomerInput!){ customerCreate(input:$input){ customer{ id } userErrors{ field message } } }`,
    { input: { phone: e164, firstName: firstName || undefined, lastName: rest.join(' ') || undefined, tags,
               note: optIn ? `WhatsApp marketing opt-in: ${new Date().toISOString()}` : undefined } }
  );
  const errs = created.customerCreate.userErrors;
  if (errs.length) throw new Error('Shopify: ' + JSON.stringify(errs));
  return created.customerCreate.customer.id;
}

// ---------- routes ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/otp/send', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Please enter a valid mobile number' });

  const prev = otps.get(phone);
  if (prev && Date.now() - prev.lastSent < RESEND_GAP_MS)
    return res.status(429).json({ ok: false, error: 'Please wait 30 seconds before requesting another OTP' });
  if (!rateOk('ip:' + req.ip, MAX_SENDS_PER_IP_HOUR) || !rateOk('ph:' + phone, MAX_SENDS_PER_HOUR))
    return res.status(429).json({ ok: false, error: 'Too many attempts, please try again later' });

  const otp = genOtp();
  try {
    await sendWhatsAppOtp(phone, otp, req.body?.name);
  } catch (e) {
    console.error(e.message);
    return res.status(502).json({ ok: false, error: 'Could not send OTP, please try again' });
  }
  otps.set(phone, { hash: hashOtp(phone, otp), expires: Date.now() + OTP_EXPIRY_MS, attempts: 0, lastSent: Date.now() });
  res.json({ ok: true, phone: '+' + phone, expiresIn: OTP_EXPIRY_MS / 1000 });
});

app.post('/otp/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '').trim();
  const rec = phone && otps.get(phone);
  if (!rec || rec.expires < Date.now())
    return res.status(400).json({ ok: false, error: 'OTP expired, please request a new one' });
  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    otps.delete(phone);
    return res.status(429).json({ ok: false, error: 'Too many wrong attempts, please request a new OTP' });
  }
  rec.attempts++;
  const a = Buffer.from(hashOtp(phone, otp)), b = Buffer.from(rec.hash);
  if (!crypto.timingSafeEqual(a, b)) return res.status(400).json({ ok: false, error: 'Incorrect OTP' });

  otps.delete(phone);
  const optIn = !!req.body?.whatsappOptIn;
  let customerId = null;
  try { customerId = await upsertCustomer(phone, req.body?.name, optIn); }
  catch (e) { console.error(e.message); } // login still succeeds even if Shopify save fails

  const token = signToken({ phone: '+' + phone, cid: customerId, exp: Date.now() + TOKEN_TTL_MS });
  res.json({ ok: true, token, phone: '+' + phone, expiresAt: Date.now() + TOKEN_TTL_MS });
});

app.post('/session', (req, res) => {
  const p = readToken(req.body?.token);
  res.json(p ? { ok: true, phone: p.phone } : { ok: false });
});

app.listen(PORT, () => console.log(`Biesca OTP API running on :${PORT}`));
