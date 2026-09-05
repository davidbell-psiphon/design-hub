// Cloudflare Access JWT verification.
//
// Verifies the token Access injects as Cf-Access-Jwt-Assertion, which the
// Pages proxy forwards on. Hand-rolled against WebCrypto rather than pulling
// in `jose`: this repo has no package.json and no build step, and a dependency
// here would mean an npm install on every deploy.
//
// Extracted from worker/index.js so the verification can be tested against
// tokens signed in the test itself.

let _keys = null;
let _keysAt = 0;

// Tests call this between cases — the one-hour cache would otherwise let a key
// set from an earlier case validate a later one and hide a real failure.
export function resetAccessKeyCache() {
  _keys = null;
  _keysAt = 0;
}

async function accessKeys(env) {
  const now = Date.now();
  if (_keys && now - _keysAt < 3600_000) return _keys;
  const res = await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) return null;
  const body = await res.json();
  _keys = body.keys || null;
  _keysAt = now;
  return _keys;
}

function b64url(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(str) {
  return JSON.parse(new TextDecoder().decode(b64url(str)));
}

// Returns the token payload, or null. Null means "not a valid human request",
// never "probably fine".
export async function accessIdentity(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch { return null; }
  if (header.alg !== 'RS256') return null;

  const keys = await accessKeys(env);
  const jwk = keys && keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch { return null; }
  if (!ok) return null;

  // Signature is good; the claims still have to be ours and current.
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;

  return payload;
}
