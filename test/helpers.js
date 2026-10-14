// Test helpers: a mock Supabase server (Auth + PostgREST + Storage) that enforces RLS-like rules,
// a fake safeStorage, and a tiny valid PNG factory. Nothing here talks to the real Supabase.
const http = require('http');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString()
};

const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

function readBody(req) {
  return new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
}

async function startSupabase() {
  const users = {
    'alice@example.com': { id: '11111111-1111-1111-1111-111111111111', password: 'correct-horse', confirmed: true },
    'bob@example.com': { id: '22222222-2222-2222-2222-222222222222', password: 'hunter22', confirmed: false }
  };
  const profiles = {
    '11111111-1111-1111-1111-111111111111': { id: '11111111-1111-1111-1111-111111111111', username: 'AliceMC', skin_path: null, updated_at: null },
    '22222222-2222-2222-2222-222222222222': { id: '22222222-2222-2222-2222-222222222222', username: 'BobMC', skin_path: 'x', updated_at: null }
  };
  const files = new Map();            // "bucket/path" -> Buffer
  const access = new Map();           // token -> { uid, expired }
  const refresh = new Map();          // refresh token -> { uid, used }
  const calls = { password: 0, refresh: 0, logout: 0, rest: 0, upload: 0 };
  let n = 0;
  const state = { down: false, hideFromAuthenticatedRoute: false, profileColumns: ['id', 'username', 'skin_path', 'updated_at'] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(code, { 'Content-Type': type }); res.end(b);
    };
    if (state.down) { req.socket.destroy(); return; }
    if (!req.headers.apikey) return send(401, { message: 'No API key found in request' });
    const body = await readBody(req);
    const issue = (uid, email) => {
      const at = `at_${++n}`, rt = `rt_${n}`;
      access.set(at, { uid, expired: false }); refresh.set(rt, { uid, used: false });
      return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: uid, email } };
    };
    const who = () => {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      const a = access.get(t);
      return a && !a.expired ? a.uid : null;
    };

    if (url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      const j = JSON.parse(body.toString() || '{}');
      if (grant === 'password') {
        calls.password++;
        const u = users[j.email];
        if (!u || u.password !== j.password) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (!u.confirmed) return send(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        return send(200, issue(u.id, j.email));
      }
      if (grant === 'refresh_token') {
        calls.refresh++;
        const r = refresh.get(j.refresh_token);
        if (!r || r.used) return send(400, { error: 'invalid_grant', error_code: 'refresh_token_already_used', error_description: 'Invalid Refresh Token: Already Used' });
        r.used = true;
        const email = Object.keys(users).find((e) => users[e].id === r.uid);
        return send(200, issue(r.uid, email));
      }
    }
    if (url.pathname === '/auth/v1/logout') { calls.logout++; return send(204, ''); }

    if (url.pathname === '/rest/v1/profiles') {
      calls.rest++;
      const uid = who();
      if (!uid) return send(401, { code: 'PGRST301', message: 'JWT expired' });
      const idFilter = (url.searchParams.get('id') || '').replace('eq.', '');
      if (req.method === 'GET') return send(200, idFilter === uid && profiles[uid] ? [profiles[uid]] : []);   // RLS: own row only
      if (req.method === 'PATCH') {
        const j = JSON.parse(body.toString());
        for (const k of Object.keys(j)) if (!state.profileColumns.includes(k)) return send(400, { code: 'PGRST204', message: `Could not find the '${k}' column of 'profiles' in the schema cache` });
        if (idFilter !== uid) return send(200, []);               // RLS hides foreign rows -> nothing updated
        Object.assign(profiles[uid], j);
        return send(200, [profiles[uid]]);
      }
    }

    const m = url.pathname.match(/^\/storage\/v1\/object\/(authenticated\/|public\/)?([^/]+)\/(.+)$/);
    if (m) {
      const [, mode, bucket, rawPath] = m;
      const p = decodeURIComponent(rawPath);
      const key = `${bucket}/${p}`;
      if (req.method === 'POST') {
        calls.upload++;
        const uid = who();
        if (!uid) return send(401, { message: 'JWT expired' });
        if (!p.startsWith(uid + '/')) return send(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        files.set(key, body);
        return send(200, { Key: key });
      }
      if (req.method === 'GET') {
        if (mode === 'authenticated/' && !who()) return send(401, { message: 'JWT expired' });
        if (mode === 'authenticated/' && state.hideFromAuthenticatedRoute) return send(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });   // public bucket without a SELECT policy
        return files.has(key) ? send(200, files.get(key), 'image/png') : send(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      }
    }
    send(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, users, profiles, files, access, refresh, calls, state,
    expireAllAccessTokens: () => access.forEach((a) => { a.expired = true; }),
    close: () => new Promise((r) => server.close(r))
  };
}

module.exports = { startSupabase, makePng, fakeSafeStorage, jwt };
