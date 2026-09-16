const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
function loadEnvFile() {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadEnvFile();
const supabaseUrl = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const supabaseSecret = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const customerIndexKey = String(process.env.CUSTOMER_INDEX_KEY || '');
const port = Number(process.env.PORT) || 3000;
const host = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
let supabaseActive = false;
const dataDir = path.join(root, 'data');
const bookingsFile = path.join(dataDir, 'bookings.json');
const adminFile = path.join(dataDir, 'admin.json');
const packagesFile = path.join(dataDir, 'packages.json');
const sessions = new Map();
const rateLimits = new Map();
const defaultPackages = Object.freeze([
  Object.freeze({ id: 'set-a', code: 'SET A', name: 'JBL 520 Karaoke Set', label: 'SET A · JBL 520 Karaoke Set', description: 'A clean JBL setup for simple celebrations.', features: Object.freeze(['JBL PartyBox 520 (High-Bass Speaker)', 'JBL Wireless Microphones (2pcs)']), prices: Object.freeze({ 12: 599, 22: 799 }) }),
  Object.freeze({ id: 'set-b', code: 'SET B', name: 'Complete Karaoke Set', label: 'SET B · Complete Karaoke Set', description: 'The full party setup with TV, karaoke system, and lights.', features: Object.freeze(['JBL PartyBox 520', 'JBL Wireless Microphones (2pcs)', 'SMART TV 32INCH. w/ TV STAND', 'PLATINUM KARAOKE XL SD w/ SONGBOOK', 'Disco Light', 'YouTube Premium']), prices: Object.freeze({ 12: 899, 22: 1199 }) }),
]);
const securityDeposit = 1000;
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/assets/gcash-qr.png': ['assets/gcash-qr.png', 'image/png'],
  '/assets/maribank-qr.png': ['assets/maribank-qr.png', 'image/png'],
};

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(bookingsFile)) fs.writeFileSync(bookingsFile, '[]\n');
if (!fs.existsSync(packagesFile)) fs.writeFileSync(packagesFile, '[]\n');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

const storage = {
  admin: readJson(adminFile, null),
  packages: readJson(packagesFile, []),
  bookings: readJson(bookingsFile, []),
};

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: supabaseSecret,
      Authorization: `Bearer ${supabaseSecret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${responseText.slice(0, 300)}`);
  return responseText ? JSON.parse(responseText) : null;
}

async function persistAdmin() {
  writeJson(adminFile, storage.admin);
  if (!supabaseActive || !storage.admin) return;
  await supabaseRequest('jm_admins?on_conflict=email', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ email: storage.admin.email, salt: storage.admin.salt, password_hash: storage.admin.passwordHash, updated_at: new Date().toISOString() }]) });
}

async function persistPackages() {
  writeJson(packagesFile, storage.packages);
  if (!supabaseActive || !storage.packages.length) return;
  await supabaseRequest('jm_packages?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(storage.packages.map(item => ({ id: item.id, payload: item, updated_at: new Date().toISOString() }))) });
}

function customerKeyFor(booking) {
  const identity = `${safeText(booking.email, 254).toLowerCase()}|${safeText(booking.facebook, 300).toLowerCase()}`;
  return crypto.createHmac('sha256', customerIndexKey || 'jm-karaoke-local-customer-key').update(identity).digest('hex');
}

function customerRecords() {
  const customers = new Map();
  for (const booking of storage.bookings) {
    if (!booking.customerName || !booking.email || !booking.facebook) continue;
    const customerKey = customerKeyFor(booking);
    const bookedAt = new Date(booking.createdAt || Date.now()).toISOString();
    const current = customers.get(customerKey);
    if (!current) {
      customers.set(customerKey, {
        customer_key: customerKey,
        full_name: safeText(booking.customerName, 300),
        email: safeText(booking.email, 254).toLowerCase(),
        facebook: safeText(booking.facebook, 300),
        first_booking_at: bookedAt,
        last_booking_at: bookedAt,
        booking_count: 1,
      });
      continue;
    }
    current.booking_count += 1;
    if (bookedAt < current.first_booking_at) current.first_booking_at = bookedAt;
    if (bookedAt >= current.last_booking_at) {
      current.full_name = safeText(booking.customerName, 300);
      current.email = safeText(booking.email, 254).toLowerCase();
      current.facebook = safeText(booking.facebook, 300);
      current.last_booking_at = bookedAt;
    }
  }
  return [...customers.values()];
}

async function persistCustomers() {
  const customers = customerRecords();
  if (!supabaseActive || !customers.length) return;
  await supabaseRequest('jm_customers?on_conflict=customer_key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(customers.map(customer => ({ ...customer, updated_at: new Date().toISOString() }))) });
}

async function persistBookings() {
  writeJson(bookingsFile, storage.bookings);
  if (!supabaseActive) return;
  if (storage.bookings.length) await supabaseRequest('jm_bookings?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(storage.bookings.map(item => ({ id: item.id, package_id: item.packageId || bookingPackageId(item), booking_date: item.date, status: item.status, payload: item, created_at: item.createdAt, updated_at: new Date().toISOString() }))) });
  await persistCustomers();
}

async function initializeSupabase() {
  if (!supabaseUrl || !supabaseSecret) return;
  try {
    const [admins, packages, bookings] = await Promise.all([
      supabaseRequest('jm_admins?select=email,salt,password_hash&limit=1'),
      supabaseRequest('jm_packages?select=payload'),
      supabaseRequest('jm_bookings?select=payload&order=created_at.desc'),
    ]);
    supabaseActive = true;
    if (admins[0]) storage.admin = { email: admins[0].email, salt: admins[0].salt, passwordHash: admins[0].password_hash };
    if (packages.length) storage.packages = packages.map(row => row.payload).filter(Boolean);
    else if (!storage.packages.length) storage.packages = defaultPackages.map(item => ({ ...item, features: [...item.features], prices: { ...item.prices } }));
    if (bookings.length) storage.bookings = bookings.map(row => row.payload).filter(Boolean);
    await Promise.all([persistAdmin(), persistPackages(), persistBookings()]);
    console.log('JM Karaoke: Supabase storage connected');
  } catch (error) {
    console.warn(`JM Karaoke: Supabase storage is not ready; using local storage. ${error.message}`);
  }
}

function savedPackages() {
  return Array.isArray(storage.packages) ? storage.packages : [];
}

function allPackages() {
  const saved = savedPackages();
  const defaultIds = new Set(defaultPackages.map(item => item.id));
  const savedById = new Map(saved.map(item => [item.id, item]));
  return [...defaultPackages.map(item => savedById.get(item.id) || item), ...saved.filter(item => !defaultIds.has(item.id))];
}

function packageForBooking(label) {
  return allPackages().find(item => item.label === label);
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

function requestIsHttps(req) {
  return Boolean(req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}

function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://scontent.fdvo1-2.fna.fbcdn.net https://lh3.googleusercontent.com",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (requestIsHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res, name, limit, windowMs) {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
  const existing = rateLimits.get(key);
  const entry = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  entry.count += 1;
  rateLimits.set(key, entry);
  if (entry.count <= limit) return true;
  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  json(res, 429, { ok: false, error: 'Too many requests. Please try again later.' }, { 'Retry-After': String(retryAfter) });
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function authenticated(req) {
  for (const [token, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(token);
  const token = parseCookies(req).jm_admin_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = authenticated(req);
  if (!session) {
    json(res, 401, { ok: false, error: 'Please sign in.' });
    return null;
  }
  return session;
}

function safeText(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validMapUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'maps.app.goo.gl' || host === 'www.google.com' || host === 'google.com' || host === 'maps.google.com');
  } catch {
    return false;
  }
}

function validBookingDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}

function formatPeso(amount) {
  return `₱${Number(amount).toLocaleString('en-PH')}`;
}

function baseBookingTotal(booking) {
  if (Number.isFinite(Number(booking.baseTotal)) && Number(booking.baseTotal) > 0) return Number(booking.baseTotal);
  const parsed = Number(String(booking.total || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const packageDetails = packageForBooking(booking.package);
  const rentalFee = packageDetails?.prices?.[String(booking.duration || '').toLowerCase().replace(' hours', '')];
  return Number(rentalFee || 0) + securityDeposit;
}

function buildBooking(data) {
  const packageId = safeText(data.packageId, 40);
  const duration = safeText(data.duration, 40).toLowerCase();
  const packageDetails = allPackages().find(item => item.id === packageId);
  const packageName = packageDetails?.label || '';
  const rentalFee = packageDetails?.prices?.[duration.replace(' hours', '')];
  const paymentMethod = safeText(data.paymentMethod, 40);
  const booking = {
    id: `JM-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    createdAt: new Date().toISOString(), status: 'Pending',
    packageId, package: packageName, duration, date: safeText(data.date, 10),
    customerName: safeText(data.customerName), address: safeText(data.address, 500), mapLink: safeText(data.mapLink, 1000), deliveryFee: '',
    facebook: safeText(data.facebook), email: safeText(data.email, 254).toLowerCase(),
    paymentMethod, baseTotal: rentalFee ? rentalFee + securityDeposit : 0, total: rentalFee ? `${formatPeso(rentalFee + securityDeposit)} + delivery` : '', notes: '',
  };
  if (!rentalFee || !validBookingDate(booking.date) || !booking.customerName || !booking.address || !booking.facebook || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.email) || !validMapUrl(booking.mapLink) || !['GCash', 'MariBank'].includes(paymentMethod)) return null;
  return booking;
}

function bookingPackageId(booking) {
  return safeText(booking.packageId, 40) || packageForBooking(booking.package)?.id || '';
}

function isDateReserved(booking) {
  return !['Cancelled', 'Completed'].includes(booking.status);
}

function unavailableDates() {
  const unavailable = {};
  for (const booking of storage.bookings) {
    const packageId = bookingPackageId(booking);
    if (!packageId || !validBookingDate(booking.date) || !isDateReserved(booking)) continue;
    (unavailable[packageId] ||= []).push(booking.date);
  }
  for (const packageId of Object.keys(unavailable)) unavailable[packageId] = [...new Set(unavailable[packageId])].sort();
  return unavailable;
}

function buildPackage(data) {
  const name = safeText(data.name, 70);
  const description = safeText(data.description, 180);
  const features = safeText(data.features, 1200).split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, 12);
  const price12 = Number(data.price12);
  const price22 = Number(data.price22);
  if (!name || !description || !features.length || !Number.isInteger(price12) || !Number.isInteger(price22) || price12 < 1 || price22 < 1 || price12 > 99999 || price22 > 99999 || savedPackages().filter(item => !defaultPackages.some(defaultItem => defaultItem.id === item.id)).length >= 18) return null;
  const setNumber = allPackages().length + 1;
  return {
    id: `set-${crypto.randomBytes(5).toString('hex')}`,
    code: `SET ${setNumber}`,
    name,
    label: `SET ${setNumber} · ${name}`,
    description,
    features,
    prices: { 12: price12, 22: price22 },
  };
}

function updatePackage(data, existing) {
  const name = safeText(data.name, 70);
  const description = safeText(data.description, 180);
  const features = safeText(data.features, 1200).split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, 12);
  const price12 = Number(data.price12);
  const price22 = Number(data.price22);
  if (!name || !description || !features.length || !Number.isInteger(price12) || !Number.isInteger(price22) || price12 < 1 || price22 < 1 || price12 > 99999 || price22 > 99999) return null;
  return { id: existing.id, code: existing.code, name, label: `${existing.code} · ${name}`, description, features, prices: { 12: price12, 22: price22 } };
}

function login(data, req, res) {
  const admin = storage.admin;
  if (!admin) return json(res, 503, { ok: false, error: 'Admin account is not set up.' });
  const submittedEmail = safeText(data.email).toLowerCase();
  const candidate = crypto.scryptSync(String(data.password || ''), admin.salt, 64);
  const expected = Buffer.from(admin.passwordHash, 'hex');
  const valid = submittedEmail === admin.email && expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  if (!valid) return json(res, 401, { ok: false, error: 'Incorrect email or password.' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email: admin.email, expiresAt: Date.now() + 1000 * 60 * 60 * 8 });
  json(res, 200, { ok: true, email: admin.email }, {
    'Set-Cookie': `jm_admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${requestIsHttps(req) ? '; Secure' : ''}`,
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/packages') {
    return json(res, 200, { ok: true, packages: allPackages() });
  }
  if (req.method === 'GET' && pathname === '/api/availability') {
    return json(res, 200, { ok: true, unavailable: unavailableDates() });
  }
  if (req.method === 'POST' && pathname === '/api/bookings') {
    if (!enforceRateLimit(req, res, 'booking', 8, 15 * 60 * 1000)) return;
    const data = await readBody(req);
    const booking = buildBooking(data);
    if (!booking) return json(res, 422, { ok: false, error: 'Please check your booking details and try again.' });
    const bookings = storage.bookings;
    if (bookings.some(item => bookingPackageId(item) === booking.packageId && item.date === booking.date && isDateReserved(item))) {
      return json(res, 409, { ok: false, error: 'This karaoke set is no longer available on that date. Please choose another date or set.' });
    }
    bookings.unshift(booking);
    await persistBookings();
    return json(res, 201, { ok: true, id: booking.id });
  }
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    if (!enforceRateLimit(req, res, 'admin-login', 5, 15 * 60 * 1000)) return;
    return login(await readBody(req), req, res);
  }
  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const token = parseCookies(req).jm_admin_session;
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'jm_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && pathname === '/api/admin/session') {
    const session = requireAdmin(req, res);
    if (session) json(res, 200, { ok: true, email: session.email });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/bookings') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { ok: true, bookings: storage.bookings });
  }
  if (req.method === 'GET' && pathname === '/api/admin/packages') {
    if (!requireAdmin(req, res)) return;
    return json(res, 200, { ok: true, packages: allPackages() });
  }
  if (req.method === 'POST' && pathname === '/api/admin/packages') {
    if (!requireAdmin(req, res)) return;
    if (!enforceRateLimit(req, res, 'admin-write', 60, 15 * 60 * 1000)) return;
    const newPackage = buildPackage(await readBody(req));
    if (!newPackage) return json(res, 422, { ok: false, error: 'Add a name, short description, at least one included item, and valid 12- and 22-hour prices.' });
    storage.packages.push(newPackage);
    await persistPackages();
    return json(res, 201, { ok: true, package: newPackage });
  }
  if (req.method === 'PATCH' && pathname === '/api/admin/packages') {
    if (!requireAdmin(req, res)) return;
    if (!enforceRateLimit(req, res, 'admin-write', 60, 15 * 60 * 1000)) return;
    const data = await readBody(req);
    const id = safeText(data.id, 40);
    const existing = allPackages().find(item => item.id === id);
    if (!existing) return json(res, 404, { ok: false, error: 'Karaoke set not found.' });
    const updatedPackage = updatePackage(data, existing);
    if (!updatedPackage) return json(res, 422, { ok: false, error: 'Add a name, short description, at least one included item, and valid 12- and 22-hour prices.' });
    const stored = storage.packages;
    const savedIndex = stored.findIndex(item => item.id === id);
    if (savedIndex === -1) stored.push(updatedPackage); else stored[savedIndex] = updatedPackage;
    await persistPackages();
    return json(res, 200, { ok: true, package: updatedPackage });
  }
  if (req.method === 'PATCH' && pathname === '/api/admin/bookings') {
    if (!requireAdmin(req, res)) return;
    if (!enforceRateLimit(req, res, 'admin-write', 60, 15 * 60 * 1000)) return;
    const data = await readBody(req);
    const allowed = ['Pending', 'Delivery fee sent', 'Reservation paid', 'Confirmed', 'Cancelled', 'Completed'];
    if (!/^JM-\d{13}-[A-F0-9]{6}$/.test(safeText(data.id, 40))) return json(res, 422, { ok: false, error: 'Invalid booking.' });
    if (data.status && !allowed.includes(data.status)) return json(res, 422, { ok: false, error: 'Invalid status.' });
    const deliveryFee = data.deliveryFee === undefined ? undefined : safeText(data.deliveryFee, 40);
    if (deliveryFee && !/^\d{1,5}(\.\d{1,2})?$/.test(deliveryFee)) return json(res, 422, { ok: false, error: 'Enter a valid delivery fee.' });
    const bookings = storage.bookings;
    const booking = bookings.find(item => item.id === data.id);
    if (!booking) return json(res, 404, { ok: false, error: 'Booking not found.' });
    if (data.status) booking.status = data.status;
    if (deliveryFee !== undefined) {
      booking.deliveryFee = deliveryFee;
      const baseTotal = baseBookingTotal(booking);
      booking.baseTotal = baseTotal;
      booking.total = deliveryFee ? formatPeso(baseTotal + Number(deliveryFee)) : `${formatPeso(baseTotal)} + delivery`;
    }
    await persistBookings();
    return json(res, 200, { ok: true, id: booking.id, status: booking.status, deliveryFee: booking.deliveryFee, total: booking.total });
  }
  return json(res, 404, { ok: false, error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  setSecurityHeaders(req, res);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    const file = publicFiles[url.pathname];
    if (!file || req.method !== 'GET') return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(root, file[0])).pipe(res);
  } catch (error) {
    console.warn(`[server] Request rejected: ${error.name}`);
    json(res, 400, { ok: false, error: 'Unable to process this request.' });
  }
});

initializeSupabase().finally(() => {
  server.listen(port, host, () => console.log(`JM Karaoke: http://${host}:${port}`));
});
