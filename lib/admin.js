const crypto = require('node:crypto');
const COOKIE = 'carroll_admin';
const MAX_AGE = 8 * 60 * 60;
const attempts = new Map();
function config() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  return username && password?.length >= 12 && secret?.length >= 32 ? { username, password, secret } : null;
}
function equal(a, b) {
  const hash = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}
function signature(payload, cfg) {
  return crypto.createHmac('sha256', cfg.secret).update(payload).update(cfg.password).digest('base64url');
}
function getAdmin(req) {
  const cfg = config();
  if (!cfg) return null;
  const token = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!token || token.length > 2048) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra || !equal(signature(payload, cfg), sig)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (session.username !== cfg.username || session.expires <= Date.now()) return null;
    return { username: cfg.username, role: 'admin' };
  } catch { return null; }
}
function cookie(req, token, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail('Enter a player name of 1–80 characters.');
  return value.trim().replace(/\s+/g, ' ');
}
function addPlayer(db, value) {
  const fullName = name(value);
  if (db.players.some(p => p.name.trim().toLowerCase() === fullName.toLowerCase())) fail('A player with that name already exists. Select the existing player.', 409);
  const player = { id: crypto.randomUUID(), accountId: null, name: fullName, username: null, elo: 1000, wins: 0, losses: 0, createdByAdmin: true };
  db.players.push(player);
  return player;
}
function recordMatch(db, body, admin) {
  if (typeof body.requestId !== 'string' || !/^[\w-]{8,80}$/.test(body.requestId)) fail('A valid request ID is required.');
  const duplicate = db.matches.find(m => m.adminRequestId === body.requestId);
  if (duplicate) return duplicate;
  const winner = db.players.find(p => String(p.id) === String(body.winnerId));
  const loser = db.players.find(p => String(p.id) === String(body.loserId));
  if (!winner || !loser) fail('Select two existing roster players.', 404);
  if (winner === loser) fail('Winner and loser must be different players.');
  const { winnerScore, loserScore } = body;
  if (![winnerScore, loserScore].every(n => Number.isInteger(n) && n >= 0 && n <= 99) || winnerScore <= loserScore) fail('Enter scores from 0–99; the winner must have the higher score.');
  if (![winner.elo, loser.elo].every(Number.isFinite)) fail('Player ratings need review before recording a match.', 409);
  const gain = Math.max(1, Math.round(32 * (1 - 1 / (1 + 10 ** ((loser.elo - winner.elo) / 400)))));
  const loss = Math.min(gain, Math.max(0, loser.elo - 100));
  winner.elo += gain; loser.elo -= loss;
  winner.wins = (winner.wins || 0) + 1; loser.losses = (loser.losses || 0) + 1;
  const match = { id: Math.max(Date.now(), ...db.matches.map(m => Number(m.id) || 0)) + 1,
    winnerId: winner.id, loserId: loser.id, winnerName: winner.name, loserName: loser.name,
    score: `${winnerScore}-${loserScore}`, date: new Date().toISOString(), winnerChange: gain, loserChange: loss,
    confirmations: {}, eloApplied: true, verification: 'admin', recordedBy: admin.username, adminRequestId: body.requestId };
  db.matches.push(match);
  return match;
}
async function handleAdmin(req, res, pathname, { parse, send, mutate }) {
  if (!pathname.startsWith('/api/admin/')) return false;
  try {
    if (req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) fail('Use application/json.', 415);
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('Cross-origin requests are not allowed.', 403);
    }
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const cfg = config();
      if (!cfg) fail('Admin access has not been configured on the server.', 503);
      const body = await parse(req);
      const key = req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      for (const [ip, item] of attempts) if (item.until < now) attempts.delete(ip);
      const attempt = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
      if (attempt.count >= 10) fail('Too many login attempts. Try again in 15 minutes.', 429);
      if (!equal(body.username, cfg.username) || !equal(body.password, cfg.password)) {
        attempt.count++; attempts.set(key, attempt); fail('Incorrect admin username or password.', 401);
      }
      attempts.delete(key);
      const payload = Buffer.from(JSON.stringify({ username: cfg.username, expires: now + MAX_AGE * 1000 })).toString('base64url');
      res.setHeader('Set-Cookie', cookie(req, `${payload}.${signature(payload, cfg)}`, MAX_AGE));
      send(res, 200, { success: true, admin: { username: cfg.username, role: 'admin' } }); return true;
    }
    if (pathname === '/api/admin/session' && req.method === 'GET') {
      send(res, 200, { success: true, admin: getAdmin(req) }); return true;
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', cookie(req, '', 0)); send(res, 200, { success: true }); return true;
    }
    const admin = getAdmin(req);
    if (!admin) fail('Admin sign-in is required.', 401);
    if (pathname === '/api/admin/players' && req.method === 'POST') {
      const body = await parse(req);
      const player = await mutate(db => addPlayer(db, body.name));
      send(res, 201, { success: true, player }); return true;
    }
    if (pathname === '/api/admin/matches' && req.method === 'POST') {
      const body = await parse(req);
      const match = await mutate(db => recordMatch(db, body, admin));
      send(res, 201, { success: true, match }); return true;
    }
    fail('Endpoint not found.', 404);
  } catch (error) { send(res, error.status || 500, { success: false, error: error.status ? error.message : 'Could not save changes. Please retry.' }); return true; }
}
module.exports = { handleAdmin, getAdmin, addPlayer, recordMatch };
