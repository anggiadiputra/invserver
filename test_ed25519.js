import crypto from 'node:crypto';
// fetch is global in Node.js 18+

const NEON_JWKS_URL =
  'https://ep-square-lake-a1ky6q1k.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth/.well-known/jwks.json';

async function importPublicKey(jwk) {
  const subtle = crypto.webcrypto.subtle;
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['verify']);
  }
  return subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, [
    'verify',
  ]);
}

async function test() {
  try {
    console.log('Fetching JWKS...');
    const res = await fetch(NEON_JWKS_URL);
    const data = await res.json();
    const jwk = data.keys[0];
    console.log('JWK fetched:', JSON.stringify(jwk));

    console.log('Attempting to import key...');
    const key = await importPublicKey(jwk);
    console.log('Key imported successfully!');
    console.log('Key Object:', key);
  } catch (err) {
    console.error('Test failed:', err);
  }
}

test();
