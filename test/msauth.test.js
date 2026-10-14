const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const msauth = require('../src/msauth');

async function startMock(opts = {}) {
  const calls = { device: 0, token: 0, xbl: 0, xsts: 0, mc: 0, profile: 0 };
  let pending = opts.pendingPolls ?? 2;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/devicecode') { calls.device++; return send(200, { device_code: 'DEV', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/link', interval: 5, expires_in: 900 }); }
    if (req.url === '/token') {
      calls.token++;
      const f = new URLSearchParams(raw);
      if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === 'MS_REFRESH_1' ? send(200, { access_token: 'MS_AT_2', refresh_token: 'MS_REFRESH_2' }) : send(400, { error: 'invalid_grant' });
      if (opts.declined) return send(400, { error: 'authorization_declined' });
      if (pending-- > 0) return send(400, { error: pending === 0 && opts.slowDown ? 'slow_down' : 'authorization_pending' });
      return send(200, { access_token: 'MS_AT_1', refresh_token: 'MS_REFRESH_1' });
    }
    if (req.url === '/xbl') { calls.xbl++; assert.ok(JSON.parse(raw).Properties.RpsTicket.startsWith('d=')); return send(200, { Token: 'XBL_TOKEN' }); }
    if (req.url === '/xsts') {
      calls.xsts++;
      if (opts.xerr) return send(401, { XErr: opts.xerr });
      const j = JSON.parse(raw);
      assert.deepEqual(j.Properties.UserTokens, ['XBL_TOKEN']); assert.equal(j.RelyingParty, 'rp://api.minecraftservices.com/');
      return send(200, { Token: 'XSTS_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS123' }] } });
    }
    if (req.url === '/mclogin') {
      calls.mc++;
      if (opts.mc403) return send(403, { error: 'Forbidden' });
      assert.equal(JSON.parse(raw).identityToken, 'XBL3.0 x=UHS123;XSTS_TOKEN');
      return send(200, { access_token: 'MC_TOKEN', expires_in: 86400 });
    }
    if (req.url === '/profile') {
      calls.profile++;
      assert.equal(req.headers.authorization, 'Bearer MC_TOKEN');
      if (opts.noGame) return send(404, { error: 'NOT_FOUND' });
      return send(200, { id: 'abcdef0123456789abcdef0123456789', name: 'Steve_Licensed', skins: [{ state: 'ACTIVE', variant: 'SLIM', url: 'https://textures.minecraft.net/texture/abc' }] });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${server.address().port}`;
  const urls = { deviceCode: b + '/devicecode', token: b + '/token', xblAuth: b + '/xbl', xstsAuth: b + '/xsts', mcLogin: b + '/mclogin', mcProfile: b + '/profile' };
  return { urls, calls, close: () => new Promise((r) => server.close(r)) };
}
const make = (urls, clientId = 'client-id-123') => msauth.create({ clientId, urls, sleep: async () => {} });

test('device code login: polls (incl. slow_down) until confirmed, then Xbox -> XSTS -> Minecraft profile', async (t) => {
  const m = await startMock({ pendingPolls: 2, slowDown: true }); t.after(m.close);
  const ms = make(m.urls);
  const dc = await ms.deviceCode();
  assert.equal(dc.user_code, 'ABCD-1234'); assert.equal(dc.verification_uri, 'https://microsoft.com/link');
  const tok = await ms.pollDevice(dc);
  assert.equal(tok.refresh_token, 'MS_REFRESH_1'); assert.equal(m.calls.token, 3);
  const p = await ms.xboxChain(tok.access_token);
  assert.deepEqual([p.uuid, p.name, p.mcToken, p.model], ['abcdef0123456789abcdef0123456789', 'Steve_Licensed', 'MC_TOKEN', 'slim']);
  assert.ok(p.mcExpires > Date.now() + 3600 * 1000);
  assert.match(p.skinUrl, /textures\.minecraft\.net/);
});

test('refresh token flow gives a new token pair; a revoked token asks for a new login', async (t) => {
  const m = await startMock(); t.after(m.close);
  const tok = await make(m.urls).refresh('MS_REFRESH_1');
  assert.equal(tok.refresh_token, 'MS_REFRESH_2');
  await assert.rejects(() => make(m.urls).refresh('REVOKED'), (e) => e.code === 'session_expired');
});

test('user can cancel while waiting (AbortSignal)', async (t) => {
  const m = await startMock({ pendingPolls: 99 }); t.after(m.close);
  const ms = msauth.create({ clientId: 'x', urls: m.urls });          // real sleep: abort must interrupt it
  const dc = await ms.deviceCode();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(() => ms.pollDevice(dc, { signal: ac.signal }), (e) => e.code === 'cancelled');
});

test('declined in the browser', async (t) => {
  const m = await startMock({ declined: true }); t.after(m.close);
  const ms = make(m.urls);
  await assert.rejects(async () => ms.pollDevice(await ms.deviceCode()), (e) => e.code === 'declined');
});

test('Xbox account problems are explained', async (t) => {
  const a = await startMock({ xerr: 2148916233 }); t.after(a.close);
  await assert.rejects(() => make(a.urls).xboxChain('x'), (e) => e.code === 'xsts' && /нет профиля Xbox/.test(e.message));
  const b = await startMock({ xerr: 2148916238 }); t.after(b.close);
  await assert.rejects(() => make(b.urls).xboxChain('x'), /родител/);
});

test('an account without Minecraft Java is rejected with a clear message', async (t) => {
  const m = await startMock({ noGame: true }); t.after(m.close);
  await assert.rejects(() => make(m.urls).xboxChain('x'), (e) => e.code === 'no_game' && /нет лицензии/.test(e.message));
});

test('app not approved by Mojang (403) is explained', async (t) => {
  const m = await startMock({ mc403: true }); t.after(m.close);
  await assert.rejects(() => make(m.urls).xboxChain('x'), (e) => e.code === 'app_not_approved');
});

test('missing Client ID -> setup instructions and no request', async (t) => {
  const m = await startMock(); t.after(m.close);
  await assert.rejects(() => make(m.urls, '').deviceCode(), (e) => e.code === 'config' && /Client ID/.test(e.message));
  assert.equal(m.calls.device, 0);
});
