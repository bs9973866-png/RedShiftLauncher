// Tests for the REDSHIFT account client (src/supabase.js) against a local mock of Supabase Auth / PostgREST / Storage.
// They check OUR client's behaviour. They cannot prove that the real project's RLS policies are configured correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSupabase, makePng, jwt } = require('./helpers');
const supabase = require('../src/supabase');
const CONFIG = require('../src/config');

const ALICE = '11111111-1111-1111-1111-111111111111';
const KEY = 'sb_publishable_test_key';

// in-memory stand-in for main.js' encrypted secureStore (load / save / clear)
function memStore() {
  let data = null; const log = { saves: 0, clears: 0 };
  return { load: () => (data ? JSON.parse(data) : null), save: (o) => { data = JSON.stringify(o); log.saves++; return true; }, clear: () => { data = null; log.clears++; }, log, raw: () => data };
}
function client(srv, { store = memStore(), clock = Date.now, key = KEY } = {}) {
  return { store, make: () => supabase.create({ url: srv.url, key, store, now: clock }) };
}

test('sign in: valid credentials -> session with the same user id as the website', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  const info = await sb.signIn('  alice@example.com ', 'correct-horse');
  assert.equal(info.loggedIn, true);
  assert.equal(info.userId, ALICE);
  assert.equal(info.email, 'alice@example.com');
});

test('sign in: wrong password -> clear message, no session', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await assert.rejects(() => sb.signIn('alice@example.com', 'nope'), (e) => e.code === 'invalid_credentials' && /Неверная почта или пароль/.test(e.message));
  assert.equal(sb.info().loggedIn, false);
});

test('sign in: unconfirmed email is explained', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  await assert.rejects(() => client(srv).make().signIn('bob@example.com', 'hunter22'), (e) => e.code === 'email_not_confirmed' && /не подтверждена/.test(e.message));
});

test('sign in: no key configured -> instructions, no request', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  await assert.rejects(() => client(srv, { key: '' }).make().signIn('a@b.c', 'x'), (e) => e.code === 'no_key' && /Publishable Key/.test(e.message));
  assert.equal(srv.calls.password, 0);
});

test('sign in: network failure -> readable error', async (t) => {
  const srv = await startSupabase();
  const sb = client(srv).make();
  await srv.close();
  await assert.rejects(() => sb.signIn('alice@example.com', 'correct-horse'), (e) => e.code === 'network' && /Нет соединения/.test(e.message));
});

test('session persistence: restart restores the login without a password; password is never stored', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const c = client(srv);
  await c.make().signIn('alice@example.com', 'correct-horse');
  assert.ok(c.store.log.saves >= 1);
  assert.ok(!c.store.raw().includes('correct-horse'));
  const restored = await c.make().init();                       // a "new app run"
  assert.equal(restored.loggedIn, true);
  assert.equal(restored.userId, ALICE);
  assert.equal(srv.calls.password, 1, 'no second password login');
});

test('session restore: expired access token is refreshed and the rotated token is persisted', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  let time = Date.now();
  const c = client(srv, { clock: () => time });
  await c.make().signIn('alice@example.com', 'correct-horse');
  time += 2 * 3600 * 1000;
  assert.equal((await c.make().init()).loggedIn, true);
  assert.equal(srv.calls.refresh, 1);
  assert.equal((await c.make().init()).loggedIn, true, 'rotated refresh token works after another restart');
});

test('session restore: revoked refresh token -> signed out and storage cleared', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  let time = Date.now();
  const c = client(srv, { clock: () => time });
  await c.make().signIn('alice@example.com', 'correct-horse');
  srv.refresh.forEach((r) => { r.used = true; });
  time += 2 * 3600 * 1000;
  assert.equal((await c.make().init()).loggedIn, false);
  assert.equal(c.store.raw(), null, 'dead session must be removed from storage');
});

test('session restore: server unreachable keeps the saved session (no forced logout)', async (t) => {
  const srv = await startSupabase();
  let time = Date.now();
  const c = client(srv, { clock: () => time });
  await c.make().signIn('alice@example.com', 'correct-horse');
  time += 2 * 3600 * 1000;
  srv.state.down = true;
  assert.equal((await c.make().init()).loggedIn, true);
  await srv.close();
});

test('sign out: clears local session and calls the server; works offline as well', async (t) => {
  const srv = await startSupabase();
  const c = client(srv);
  const sb = c.make();
  await sb.signIn('alice@example.com', 'correct-horse');
  await sb.signOut();
  assert.equal(sb.info().loggedIn, false);
  assert.equal(srv.calls.logout, 1);
  assert.equal(c.store.raw(), null);
  assert.equal((await c.make().init()).loggedIn, false);

  const sb2 = c.make();
  await sb2.signIn('alice@example.com', 'correct-horse');
  srv.state.down = true;
  await sb2.signOut();
  assert.equal(sb2.info().loggedIn, false, 'offline sign-out must still succeed');
  assert.equal(c.store.raw(), null);
  await srv.close();
});

test('profile: username / skin_path come from the shared profiles table (own row only)', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  const p = await sb.getProfile();
  assert.equal(p.id, ALICE);
  assert.equal(p.username, 'AliceMC');
});

test('expired JWT during a request: exactly one refresh, then the request is retried', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  srv.expireAllAccessTokens();
  assert.equal((await sb.getProfile()).username, 'AliceMC');
  assert.equal(srv.calls.refresh, 1);
});

test('parallel requests with an expired token cause one refresh (refresh tokens rotate)', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  let time = Date.now();
  const sb = client(srv, { clock: () => time }).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  time += 2 * 3600 * 1000;
  await Promise.all([sb.getProfile(), sb.getProfile(), sb.getProfile()]);
  assert.equal(srv.calls.refresh, 1);
});

test('skin: invalid files are rejected locally, before any upload', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  const path = sb.defaultSkinPath();
  await assert.rejects(() => sb.uploadSkin(Buffer.from('not a png, only named skin.png'), path), (e) => e.code === 'bad_png');
  await assert.rejects(() => sb.uploadSkin(makePng(128, 128), path), (e) => e.code === 'bad_size' && /64×64 или 64×32/.test(e.message));
  await assert.rejects(() => sb.uploadSkin(makePng(64, 64).subarray(0, 40), path), (e) => e.code === 'bad_png');
  const noIend = makePng(64, 64); noIend.write('XXXX', noIend.length - 8, 'ascii');
  await assert.rejects(() => sb.uploadSkin(noIend, path), (e) => e.code === 'bad_png', 'corrupted tail');
  assert.equal(srv.calls.upload, 0);
});

test('skin: upload to <user id>/skin.png, profile.skin_path updated, file reads back identical', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  const png = makePng(64, 64);
  const path = await sb.uploadSkin(png, sb.defaultSkinPath());
  assert.equal(path, `${ALICE}/skin.png`);
  await sb.updateProfile({ skin_path: path });
  assert.equal(srv.profiles[ALICE].skin_path, `${ALICE}/skin.png`);
  assert.ok(srv.profiles[ALICE].updated_at);
  assert.ok((await sb.downloadSkin((await sb.getProfile()).skin_path)).equals(png));
  await sb.uploadSkin(makePng(64, 32), path);                  // legacy 64x32 is accepted too
});

test('skin: missing file on the server -> null, not an error', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  assert.equal(await sb.downloadSkin(`${ALICE}/gone.png`), null);
});

test('skin: PUBLIC bucket without a SELECT policy is read through the public route', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  const png = makePng(64, 64);
  await sb.uploadSkin(png, `${ALICE}/skin.png`);
  srv.state.hideFromAuthenticatedRoute = true;
  assert.ok((await sb.downloadSkin(`${ALICE}/skin.png`)).equals(png));
});

test('skin: never writes outside the user\'s own folder, whatever the profile says', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  for (const bad of ['22222222-2222-2222-2222-222222222222/skin.png', 'shared/skin.png', `../${ALICE}/skin.png`, '/abs.png', `${ALICE}/../x.png`]) {
    await assert.rejects(() => sb.uploadSkin(makePng(64, 64), bad), (e) => e.code === 'forbidden' || e.code === 'bad_path', bad);
  }
  assert.equal(srv.calls.upload, 0);
});

test('skin: a server-side RLS denial is reported as a permissions problem', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  // passes the client guard ("<uid>.png") but the mock policy only allows "<uid>/…"
  await assert.rejects(() => sb.uploadSkin(makePng(64, 64), `${ALICE}.png`), (e) => e.code === 'forbidden' && /RLS/.test(e.message));
  assert.equal(srv.calls.upload, 1, 'the request reached the server and was denied there');
});

test('profile: schema without updated_at is handled', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  srv.state.profileColumns = ['id', 'username', 'skin_path'];
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  await sb.updateProfile({ skin_path: `${ALICE}/skin.png` });
  assert.equal(srv.profiles[ALICE].skin_path, `${ALICE}/skin.png`);
});

test('profile: changing the nickname is saved to the shared table', async (t) => {
  const srv = await startSupabase(); t.after(() => srv.close());
  const sb = client(srv).make();
  await sb.signIn('alice@example.com', 'correct-horse');
  await sb.updateProfile({ username: 'AliceRenamed' });
  assert.equal(srv.profiles[ALICE].username, 'AliceRenamed');
  assert.equal((await client(srv, { store: client(srv).store }).make().signIn('alice@example.com', 'correct-horse') && (await sb.getProfile())).username, 'AliceRenamed');
});

test('config: same Supabase project as the website; no key shipped; privileged keys refused', () => {
  assert.equal(CONFIG.supabaseUrl, 'https://hkyuclomrgnochqslqlp.supabase.co');
  assert.match(CONFIG.keyProblem(jwt({ role: 'service_role' })), /service_role/);
  assert.match(CONFIG.keyProblem('sb_secret_abcdef'), /секретный/);
  assert.equal(CONFIG.keyProblem(jwt({ role: 'anon' })), '');
  assert.equal(CONFIG.keyProblem('sb_publishable_abc'), '');
  assert.equal(CONFIG.keyProblem(''), '');
});

test('source code contains no service_role / secret key and no TLS bypass', () => {
  const fs = require('fs'), path = require('path');
  const files = ['main.js', 'supabase.js', 'msauth.js', 'config.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.ok(!/sb_secret_[A-Za-z0-9]{8,}/.test(files));
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(files), 'no embedded JWT');
  assert.ok(!/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(files), 'TLS verification stays on');
  assert.ok(!/console\.(log|info|debug)\([^)]*(token|password|session)/i.test(files), 'no token logging');
});
