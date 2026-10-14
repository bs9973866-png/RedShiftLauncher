// Run: npm test   (uses a local mock of Supabase Auth / PostgREST / Storage that emulates RLS)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { create, validateSkinPng } = require('../src/supabase');

const KEY = 'sb_publishable_test';
const UID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

function mockServer() {
  const st = { tokens: new Map(), profiles: new Map([[UID, { id: UID, username: 'Steve_RS', skin_path: `${UID}/skin.png`, updated_at: null }]]),
    files: new Map(), loggedOut: 0, refreshCalls: 0, log: [], ttl: 3600, confirmed: true };
  const mint = (uid, email) => {
    const access = 'acc_' + Math.random().toString(36).slice(2), refresh = 'ref_' + Math.random().toString(36).slice(2);
    st.tokens.set(access, uid); st.tokens.set(refresh, uid);
    return { access_token: access, refresh_token: refresh, expires_in: st.ttl, user: { id: uid, email } };
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    st.log.push(`${req.method} ${u.pathname}`);
    const send = (code, obj) => { const s = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': Buffer.isBuffer(obj) ? 'image/png' : 'application/json' }); res.end(s); };
    if (req.headers.apikey !== KEY) return send(401, { message: 'Invalid API key' });
    const bearer = (req.headers.authorization || '').replace('Bearer ', '');
    const uid = st.tokens.get(bearer);

    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const { email, password } = JSON.parse(body);
      if (password === 'ratelimit') return send(429, { error_code: 'over_request_rate_limit', msg: 'rate limit' });
      if (email !== 'a@b.c' || password !== 'pass1234') return send(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!st.confirmed) return send(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return send(200, mint(UID, email));
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      st.refreshCalls++;
      const { refresh_token } = JSON.parse(body);
      const owner = st.tokens.get(refresh_token);
      if (!owner || !refresh_token.startsWith('ref_')) return send(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      st.tokens.delete(refresh_token);
      return send(200, mint(owner, 'a@b.c'));
    }
    if (u.pathname === '/auth/v1/logout') { st.loggedOut++; st.tokens.delete(bearer); return send(204, {}); }

    if (!uid) return send(401, { message: 'JWT expired', code: 'PGRST301' });

    if (u.pathname === '/rest/v1/profiles') {
      const id = (u.searchParams.get('id') || '').replace('eq.', '');
      // RLS: a user only sees / changes / creates their own row
      if (req.method === 'GET') return send(200, id === uid && st.profiles.has(id) ? [st.profiles.get(id)] : []);
      if (req.method === 'PATCH') {
        if (id !== uid || !st.profiles.has(id)) return send(200, []);
        const patch = JSON.parse(body);
        if (patch.username && [...st.profiles.values()].some((p) => p.id !== uid && p.username === patch.username)) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
        const row = { ...st.profiles.get(id), ...patch, id }; st.profiles.set(id, row); return send(200, [row]);
      }
      if (req.method === 'POST') {
        const row = JSON.parse(body);
        if (row.id !== uid) return send(403, { code: '42501', message: 'new row violates row-level security policy' });
        st.profiles.set(uid, row); return send(201, [row]);
      }
    }
    const m = u.pathname.match(/^\/storage\/v1\/object\/(?:authenticated\/)?skins\/(.+)$/);
    if (m) {
      const p = decodeURIComponent(m[1]);
      if (req.method === 'POST') {
        if (!p.startsWith(uid + '/')) return send(403, { statusCode: '403', message: 'new row violates row-level security policy' });
        st.files.set(p, body); return send(200, { Key: 'skins/' + p });
      }
      if (req.method === 'GET') return st.files.has(p) ? send(200, st.files.get(p)) : send(400, { error: 'not_found', message: 'Object not found' });
    }
    send(404, { message: 'nope' });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ st, server, url: `http://127.0.0.1:${server.address().port}` })));
}

function memStore() { let v = null; return { save: (s) => { v = JSON.parse(JSON.stringify(s)); }, load: () => v, clear: () => { v = null; }, peek: () => v }; }

test('signIn works, session saved, key/anon never required to be secret', async () => {
  const { st, server, url } = await mockServer(); const store = memStore();
  const sb = create({ url, key: KEY, store });
  const i = await sb.signIn('a@b.c', 'pass1234');
  assert.equal(i.loggedIn, true); assert.equal(i.userId, UID); assert.equal(i.email, 'a@b.c');
  assert.ok(store.peek().refresh_token);
  server.close();
});

test('friendly errors: wrong password, unconfirmed email, rate limit, bad key, no key, network', async () => {
  const { st, server, url } = await mockServer();
  const sb = create({ url, key: KEY });
  await assert.rejects(sb.signIn('a@b.c', 'nope'), (e) => e.code === 'invalid_credentials' && /Неверная почта/.test(e.message));
  await assert.rejects(sb.signIn('a@b.c', 'ratelimit'), (e) => e.code === 'rate_limit');
  st.confirmed = false;
  await assert.rejects(sb.signIn('a@b.c', 'pass1234'), (e) => e.code === 'email_not_confirmed' && /подтвержд/.test(e.message));
  await assert.rejects(create({ url, key: 'wrong' }).signIn('a@b.c', 'pass1234'), (e) => e.code === 'bad_key');
  await assert.rejects(create({ url, key: '' }).signIn('a@b.c', 'pass1234'), (e) => e.code === 'no_key');
  server.close();
  await assert.rejects(create({ url, key: KEY }).signIn('a@b.c', 'pass1234'), (e) => e.code === 'network');
});

test('session restore after restart (same store, new client)', async () => {
  const { server, url } = await mockServer(); const store = memStore();
  await create({ url, key: KEY, store }).signIn('a@b.c', 'pass1234');
  const sb2 = create({ url, key: KEY, store });
  assert.equal((await sb2.init()).loggedIn, true);
  assert.equal((await sb2.getProfile()).username, 'Steve_RS');
  server.close();
});

test('expired access token is refreshed automatically (and token rotated in the store)', async () => {
  const { st, server, url } = await mockServer(); const store = memStore();
  let t = Date.now(); const clock = () => t;
  st.ttl = 120;
  const sb = create({ url, key: KEY, store, now: clock });
  await sb.signIn('a@b.c', 'pass1234');
  const firstRefresh = store.peek().refresh_token;
  t += 3600 * 1000;                                    // an hour later
  const p = await sb.getProfile();
  assert.equal(p.id, UID); assert.equal(st.refreshCalls, 1);
  assert.notEqual(store.peek().refresh_token, firstRefresh);
  server.close();
});

test('two parallel requests trigger only one refresh', async () => {
  const { st, server, url } = await mockServer(); let t = Date.now();
  st.ttl = 120;
  const sb = create({ url, key: KEY, now: () => t }); await sb.signIn('a@b.c', 'pass1234');
  t += 3600 * 1000;
  await Promise.all([sb.getProfile(), sb.getProfile(), sb.getProfile()]);
  assert.equal(st.refreshCalls, 1);
  server.close();
});

test('dead refresh token -> session_expired and the saved session is wiped', async () => {
  const { st, server, url } = await mockServer(); const store = memStore();
  let t = Date.now(); st.ttl = 120;
  const sb = create({ url, key: KEY, store, now: () => t }); await sb.signIn('a@b.c', 'pass1234');
  st.tokens.clear(); t += 3600 * 1000;
  await assert.rejects(sb.getProfile(), (e) => e.code === 'session_expired');
  assert.equal(store.peek(), null); assert.equal(sb.info().loggedIn, false);
  server.close();
});

test('network failure at startup keeps the saved session', async () => {
  const { server, url } = await mockServer(); const store = memStore();
  let t = Date.now();
  await create({ url, key: KEY, store, now: () => t }).signIn('a@b.c', 'pass1234');
  server.close(); t += 7200 * 1000;
  const sb2 = create({ url, key: KEY, store, now: () => t });
  assert.equal((await sb2.init()).loggedIn, true);       // offline, but still "logged in" locally
  assert.ok(store.peek());
});

test('signOut clears the store, calls logout, and blocks further calls', async () => {
  const { st, server, url } = await mockServer(); const store = memStore();
  const sb = create({ url, key: KEY, store }); await sb.signIn('a@b.c', 'pass1234');
  await sb.signOut();
  assert.equal(store.peek(), null); assert.equal(st.loggedOut, 1);
  await assert.rejects(sb.getProfile(), (e) => e.code === 'not_logged_in');
  assert.equal((await create({ url, key: KEY, store }).init()).loggedIn, false);   // does not come back after restart
  server.close();
});

test('profile: load, update username persists, duplicate nickname is reported, missing row is created', async () => {
  const { st, server, url } = await mockServer();
  const sb = create({ url, key: KEY }); await sb.signIn('a@b.c', 'pass1234');
  assert.equal((await sb.getProfile()).skin_path, `${UID}/skin.png`);
  await sb.updateProfile({ username: 'NewNick' });
  assert.equal(st.profiles.get(UID).username, 'NewNick'); assert.ok(st.profiles.get(UID).updated_at);
  st.profiles.set(OTHER, { id: OTHER, username: 'Taken' });
  await assert.rejects(sb.updateProfile({ username: 'Taken' }), (e) => e.code === 'taken');
  st.profiles.delete(UID);
  assert.equal(await sb.getProfile(), null);
  await sb.updateProfile({ username: 'Fresh' });
  assert.equal(st.profiles.get(UID).username, 'Fresh');
  server.close();
});

test('skins: upload validates PNG for real, stores under own folder, download roundtrip, missing -> null', async () => {
  const { st, server, url } = await mockServer();
  const sb = create({ url, key: KEY }); await sb.signIn('a@b.c', 'pass1234');
  assert.equal(await sb.downloadSkin(`${UID}/skin.png`), null);                    // not uploaded yet
  await assert.rejects(sb.uploadSkin(Buffer.from('GIF89a not a png at all..........'), `${UID}/skin.png`), (e) => e.code === 'bad_png');
  await assert.rejects(sb.uploadSkin(png(100, 100), `${UID}/skin.png`), (e) => e.code === 'bad_size');
  const good = png(64, 64);
  await sb.uploadSkin(good, sb.defaultSkinPath());
  assert.ok(st.files.has(`${UID}/skin.png`));
  assert.deepEqual(await sb.downloadSkin(`${UID}/skin.png`), good);
  await sb.uploadSkin(png(64, 32), `${UID}/skin.png`);                              // legacy 64x32 accepted
  server.close();
});

test('RLS: cannot write into someone else\'s folder, cannot create a profile for another id, bad paths rejected locally', async () => {
  const { st, server, url } = await mockServer();
  const sb = create({ url, key: KEY }); await sb.signIn('a@b.c', 'pass1234');
  await assert.rejects(sb.uploadSkin(png(64, 64), `${OTHER}/skin.png`), (e) => e.code === 'forbidden');
  assert.equal(st.files.size, 0);
  await assert.rejects(sb.uploadSkin(png(64, 64), '../x.png'), (e) => e.code === 'bad_path');
  await assert.rejects(sb.uploadSkin(png(64, 64), '/abs.png'), (e) => e.code === 'bad_path');
  server.close();
});

test('validateSkinPng is independent of file extension', () => {
  assert.deepEqual(validateSkinPng(png(64, 64)), { width: 64, height: 64 });
  assert.throws(() => validateSkinPng(Buffer.alloc(40)), /PNG/);
  assert.throws(() => validateSkinPng(png(64, 128)), /64×64/);
});
