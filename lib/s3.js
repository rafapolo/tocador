// S3 access for the proxy: SigV4 signing, object-key handling and prefix -> bucket routing.
// Stateless leaves split out of proxy.js; nothing here touches the request counters.

// Minimal AWS Signature V4 — used only for S3 keys Bun's client fails on (# and ?)
const S3_ENDPOINT  = process.env.S3_ENDPOINT  ?? '';
const S3_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID ?? '';
const S3_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? '';
const S3_REGION    = 'hel1';

export async function hmacSHA256(key, data) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}
export async function sha256hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// SigV4 requires encoding all chars except A-Z a-z 0-9 - _ . ~
// encodeURIComponent leaves ! ' ( ) * unencoded; add them manually
export function sigV4Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export async function s3GetSigned(bucket, key, rangeHeader) {
  const now = new Date();
  const amzDate  = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const encodedKey = key.split('/').map(sigV4Encode).join('/');
  const url = new URL(`/${bucket}/${encodedKey}`, S3_ENDPOINT);
  const host = url.host;

  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (rangeHeader) headers['range'] = rangeHeader;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.entries(headers).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalUri = url.pathname;
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credScope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${await sha256hex(canonicalRequest)}`;

  let sigKey = await hmacSHA256(`AWS4${S3_SECRET_KEY}`, dateStamp);
  sigKey = await hmacSHA256(sigKey, S3_REGION);
  sigKey = await hmacSHA256(sigKey, 's3');
  sigKey = await hmacSHA256(sigKey, 'aws4_request');
  const sig = Array.from(await hmacSHA256(sigKey, stringToSign)).map(b => b.toString(16).padStart(2, '0')).join('');

  const auth = `AWS4-HMAC-SHA256 Credential=${S3_ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return fetch(url.href, { headers: { ...headers, Authorization: auth } });
}

// macOS writes accented filenames decomposed (NFD, "c\u0327"); most other sources
// compose them (NFC, "\u00e7"). Those are two different byte sequences, so they are
// two different S3 keys for what looks like the same name. Neither bucket is
// uniform: sambaraiz/uqt is mostly NFD with ~93 NFC keys, indie/indie is mostly
// NFC with a couple of NFD ones — so no single blanket normalization is correct.
// Try exactly what the client asked for first (one round trip for every key that
// exists), and only fall back to the other forms on a 404.
export function keyCandidates(key) {
  const out = [key];
  for (const form of ['NFC', 'NFD']) {
    const alt = key.normalize(form);
    if (!out.includes(alt)) out.push(alt);
  }
  return out;
}

// §1 — path traversal guard: reject .., ., NUL, backslash, empty segments
export function isSafeKey(key) {
  if (key.length === 0 || key.length > 1024) return false;
  if (key.includes('\0') || key.includes('\\')) return false;
  for (const seg of key.split('/')) {
    if (seg === '..' || seg === '.' || seg === '') return false;
  }
  return true;
}

export const BUCKET = process.env.S3_BUCKET;
const BUCKET_MAP = Object.fromEntries(
  (process.env.S3_BUCKET_MAP ?? '').split(',').filter(Boolean)
    .map(e => { const [p, b] = e.split(':'); return [p, b]; })
);
export function bucketFor(key) {
  for (const [prefix, bucket] of Object.entries(BUCKET_MAP)) {
    if (key.startsWith(prefix)) return bucket;
  }
  return BUCKET;
}
