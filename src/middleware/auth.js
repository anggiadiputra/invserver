import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';
import crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const NEON_JWKS_URL = process.env.NEON_JWKS_URL || '';

// ─── Local JWT (legacy email/password) ──────────────────────────────────────

export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Neon Auth / JWKS RS256 ─────────────────────────────────────────────────

let jwksCache = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getJwks() {
  if (jwksCache && Date.now() - jwksCacheTime < JWKS_CACHE_TTL) {
    return jwksCache;
  }
  if (!NEON_JWKS_URL) return null;
  try {
    const res = await fetch(NEON_JWKS_URL);
    if (!res.ok) return null;
    const data = await res.json();
    jwksCache = data.keys;
    jwksCacheTime = Date.now();
    return jwksCache;
  } catch {
    return null;
  }
}

function base64UrlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
}

async function importPublicKey(jwk) {
  const subtle = crypto.subtle || (crypto.webcrypto && crypto.webcrypto.subtle);
  if (!subtle) throw new Error('WebCrypto subtle is not available in this environment');

  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return subtle.importKey(
      'jwk',
      jwk,
      { name: 'Ed25519' },
      true,
      ['verify']
    );
  }

  // Default to RSA if kty is RSA or not specified
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
}

async function verifyNeonJWT(token) {
  try {
    const keys = await getJwks();
    if (!keys || keys.length === 0) {
      await audit('NEON VERIFY FAIL', { reason: 'JWKS keys empty or unreachable' });
      return null;
    }

    // Decode header without verifying to find kid
    const parts = token.split('.');
    if (parts.length !== 3) {
      await audit('NEON VERIFY FAIL', { reason: 'Invalid token format (not 3 parts)' });
      return null;
    }

    const [headerB64, payloadB64, sigB64] = parts;
    let header;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    } catch (e) {
      await audit('NEON VERIFY FAIL', { reason: 'Failed to parse header', error: e.message });
      return null;
    }

    // Find matching key
    const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
    if (!jwk) {
      await audit('NEON VERIFY FAIL', { reason: 'No matching JWK found for kid', kid: header.kid });
      return null;
    }

    // Verify signature
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64UrlToBuffer(sigB64);

    const publicKey = await importPublicKey(jwk);
    const subtle = crypto.subtle || (crypto.webcrypto && crypto.webcrypto.subtle);
    const data = new TextEncoder().encode(signingInput);
    
    // Determine verify algorithm based on JWK or Header
    const verifyAlgorithm = (jwk.kty === 'OKP' || header.alg === 'EdDSA') 
      ? { name: 'Ed25519' } 
      : 'RSASSA-PKCS1-v1_5';

    const valid = await subtle.verify(verifyAlgorithm, publicKey, signature, data);
    if (!valid) {
      await audit('NEON VERIFY FAIL', { reason: 'Signature invalid', alg: header.alg });
      return null;
    }

    // Decode payload
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    // Check expiry
    if (decoded.exp && Date.now() / 1000 > decoded.exp) {
      await audit('NEON VERIFY FAIL', { reason: 'Token expired', exp: decoded.exp });
      return null;
    }

    return decoded;
  } catch (error) {
    console.error('verifyNeonJWT internal error:', error);
    await audit('NEON VERIFY ERROR', { error: error.message });
    return null;
  }
}

// ─── Role Middleware ────────────────────────────────────────────────────────
export async function adminOnly(req, res, next) {
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Akses terbatas. Hanya Admin yang dapat mengakses fitur ini.' });
    }
    next();
  } catch (error) {
    console.error('adminOnly middleware error:', error);
    res.status(500).json({ error: 'Internal server error during role verification' });
  }
}

async function audit(message, details = {}) {
  try {
    await pool.query('INSERT INTO auth_logs (message, details) VALUES ($1, $2)', [message, JSON.stringify(details)]);
  } catch (err) {
    console.error('[Audit] Failed to write log:', err.message);
  }
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────

export async function authMiddleware(req, res, next) {
  let token = null;

  // 1. Read from Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // 2. Fallback: read from HttpOnly Cookie
  if (!token && req.headers.cookie) {
    const cookies = Object.fromEntries(
      req.headers.cookie.split('; ').map((c) => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx), c.slice(idx + 1)];
      })
    );
    token = cookies.token;
  }

  if (!token || token === 'null' || token === 'undefined') {
    await audit('NO TOKEN', { header: authHeader ? 'Present' : 'Missing', cookie: req.headers.cookie ? 'Present' : 'Missing' });
    return res.status(401).json({ error: 'No token provided' });
  }

  // ── Path A: Try Neon Auth JWT (RS256) ─────────────────────────────────────
  if (NEON_JWKS_URL) {
    const neonDecoded = await verifyNeonJWT(token);
    if (neonDecoded) {
      const neonId = neonDecoded.sub;
      // Extract email from common fields in BetterAuth/Neon/standard OIDC tokens
      const emailRaw = neonDecoded.email || 
                       neonDecoded.email_address || 
                       (neonDecoded.user && neonDecoded.user.email);
      
      const email = emailRaw ? emailRaw.toLowerCase() : null;

      if (!email) {
        await audit('NEON EMAIL MISSING', { payloadStart: JSON.stringify(neonDecoded).substring(0, 100) });
      }

      try {
        // 1. Precise lookup by neon_user_id
        let dbRes = await pool.query(
          'SELECT id, role FROM users WHERE neon_user_id = $1',
          [neonId]
        );

        // 2. If not found, try robust lookup by LOWER(email)
        if (dbRes.rows.length === 0 && email) {
          dbRes = await pool.query(
            'SELECT id, role FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          
          if (dbRes.rows.length > 0) {
            const existingUser = dbRes.rows[0];
            
            // SECURITY FIX: Prohibit linking to existing 'admin' accounts
            if (existingUser.role === 'admin') {
              await audit('SECURITY LINK BLOCKED', { email, neonId, reason: 'Target user is admin' });
              return res.status(403).json({ error: 'Email ini terdaftar sebagai Admin. Sinkronisasi identitas otomatis diblokir untuk keamanan.' });
            }

            await pool.query(
              'UPDATE users SET neon_user_id = $1 WHERE id = $2',
              [neonId, existingUser.id]
            );
            await audit('NEON LINKED', { email, neonId, userId: existingUser.id });
          }
        }

        // 3. If STILL not found, create a new user with FULL PROFILE
        if (dbRes.rows.length === 0 && email) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            
            const name = neonDecoded.name || email.split('@')[0];
            const [firstName, ...rest] = name.split(' ');
            
            // a. Create User
            const insertRes = await client.query(
              `INSERT INTO users (email, neon_user_id, first_name, last_name, role)
               VALUES (LOWER($1), $2, $3, $4, 'member')
               RETURNING id, role`,
              [email, neonId, firstName, rest.join(' ') || '']
            );
            const newUser = insertRes.rows[0];

            // b. Create Company Settings
            await client.query(
              'INSERT INTO company_settings (user_id, company_name, company_email) VALUES ($1, $2, $3)',
              [newUser.id, `${firstName}'s Company`, email]
            );

            // c. Create Free Subscription
            const freePlan = await client.query("SELECT id FROM plans WHERE slug = 'free'");
            if (freePlan.rows.length > 0) {
              await client.query(
                'INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, $3)',
                [newUser.id, freePlan.rows[0].id, 'active']
              );
            }

            // d. Create Wallet
            await client.query(
              'INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0)',
              [newUser.id]
            );

            await client.query('COMMIT');
            dbRes = insertRes;
            await audit('NEON CREATED FULL', { email, neonId, userId: newUser.id });
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally {
            client.release();
          }
        }

        if (dbRes.rows.length > 0) {
          req.userId = dbRes.rows[0].id;
          req.userRole = dbRes.rows[0].role; // Ensure role is set
          await audit('AUTH PATH A SUCCESS', { email, neonId, userId: req.userId });
          return next();
        } else {
          await audit('NEON NO USER', { email, neonId });
        }
      } catch (e) {
        console.error('Neon sync error:', e);
        await audit('NEON DB ERROR', { email, error: e.message });
      }
    } else {
      // Not a valid Neon token or verification failed
      // Proceed to Path B
    }
  }

  // ── Path B: Try Legacy Local JWT (HS256) ──────────────────────────────────
  const localDecoded = verifyToken(token);
  if (localDecoded) {
    const userId = localDecoded.userId;
    try {
      const userResult = await pool.query('SELECT id, role FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length > 0) {
        req.userId = userId;
        req.userRole = userResult.rows[0].role;
        await audit('AUTH PATH B SUCCESS', { userId: req.userId });
        return next();
      } else {
        await audit('LEGACY USER MISSING', { userId });
      }
    } catch (e) {
      await audit('LEGACY DB ERROR', { userId, error: e.message });
    }
  }

  await audit('AUTH FINAL FAILURE', { tokenStart: token.substring(0, 10) });
  return res.status(401).json({ error: 'Invalid or expired token' });
}
