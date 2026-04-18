import jwt from 'jsonwebtoken';
import pool from '../db/pool.js';

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

async function importRsaPublicKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
}

async function verifyNeonJWT(token) {
  const keys = await getJwks();
  if (!keys || keys.length === 0) return null;

  // Decode header without verifying to find kid
  const [headerB64] = token.split('.');
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // Find matching key
  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!jwk) return null;

  try {
    // Split token
    const [hdr, payload, sigB64] = token.split('.');
    const signingInput = `${hdr}.${payload}`;
    const signature = base64UrlToBuffer(sigB64);

    // Import public key and verify signature
    const publicKey = await importRsaPublicKey(jwk);
    const data = new TextEncoder().encode(signingInput);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, data);
    if (!valid) return null;

    // Decode payload
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    // Check expiry
    if (decoded.exp && Date.now() / 1000 > decoded.exp) return null;

    return decoded;
  } catch {
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
      const emailRaw = neonDecoded.email || neonDecoded.email_address;
      const email = emailRaw ? emailRaw.toLowerCase() : null;

      try {
        // 1. Precise lookup by neon_user_id
        let dbRes = await pool.query(
          'SELECT id FROM users WHERE neon_user_id = $1',
          [neonId]
        );

        // 2. If not found, try robust lookup by LOWER(email)
        if (dbRes.rows.length === 0 && email) {
          dbRes = await pool.query(
            'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
            [email]
          );
          
          if (dbRes.rows.length > 0) {
            await pool.query(
              'UPDATE users SET neon_user_id = $1 WHERE id = $2',
              [neonId, dbRes.rows[0].id]
            );
            await audit('NEON LINKED', { email, neonId, userId: dbRes.rows[0].id });
          }
        }

        // 3. If STILL not found, create a new user
        if (dbRes.rows.length === 0 && email) {
          const name = neonDecoded.name || email.split('@')[0];
          const [firstName, ...rest] = name.split(' ');
          
          dbRes = await pool.query(
            `INSERT INTO users (email, neon_user_id, first_name, last_name)
             VALUES (LOWER($1), $2, $3, $4)
             RETURNING id`,
            [email, neonId, firstName, rest.join(' ') || '']
          );
          await audit('NEON CREATED', { email, neonId, userId: dbRes.rows[0].id });
        }

        if (dbRes.rows.length > 0) {
          req.userId = dbRes.rows[0].id;
          return next();
        } else {
          await audit('NEON NO USER', { email, neonId });
        }
      } catch (e) {
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
