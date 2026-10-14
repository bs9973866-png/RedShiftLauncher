// Single place for all connection settings. Nothing else in the app hard-codes URLs or keys.
//
// NOTE: this file was re-created after being overwritten by mistake; it keeps the flat shape main.js expects.
//
// The Supabase *publishable* key is resolved in this order (first non-empty wins):
//   1. Settings -> Основные -> «Publishable Key» in the launcher (settings.sbKey, handled in main.js)
//   2. redshift.config.json in the project root (copy redshift.config.example.json), bundled into the app
//   3. environment variable REDSHIFT_SUPABASE_KEY
// Only a publishable / anon key may be used in a client app. Secret / service_role keys are refused.
const fs = require('fs');
const path = require('path');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const file = readJSON(path.join(__dirname, '..', 'redshift.config.json'));
const env = process.env;

// Returns a reason string if the key must not be used in a client application, otherwise ''.
function keyProblem(key) {
  if (!key) return '';
  if (/^sb_secret_/i.test(key)) return 'Это секретный ключ (sb_secret_…). В лаунчере нужен Publishable Key (sb_publishable_… или anon).';
  const parts = String(key).split('.');
  if (parts.length === 3) {
    try {
      const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role;
      if (role && role !== 'anon') return `Ключ с ролью «${role}» нельзя использовать в приложении. Нужен anon / publishable.`;
    } catch { /* not a decodable JWT: leave it to the server */ }
  }
  return '';
}

module.exports = {
  // same Supabase project as the REDSHIFT website
  supabaseUrl: String(env.REDSHIFT_SUPABASE_URL || file.supabaseUrl || 'https://hkyuclomrgnochqslqlp.supabase.co').replace(/\/+$/, ''),
  supabaseKey: env.REDSHIFT_SUPABASE_KEY || file.supabaseKey || file.supabasePublishableKey || '',
  siteUrl: env.REDSHIFT_SITE_URL || file.siteUrl || '',
  msClientId: env.REDSHIFT_MS_CLIENT_ID || file.msClientId || '',
  skinsBucket: file.skinsBucket || 'skins',
  skinPathTemplate: file.skinPathTemplate || '{uid}/skin.png',
  keyProblem
};
