import pool from '../db/pool.js';

/**
 * Verifies a Cloudflare Turnstile token
 * @param {string} token - The token received from the frontend
 * @returns {Promise<boolean>} - True if verification succeeds or is skipped (no secret key)
 * @throws {Error} - If verification fails
 */
export async function verifyTurnstileToken(token) {
  try {
    // 1. Get the secret key from system_settings
    const result = await pool.query('SELECT turnstile_secret_key FROM system_settings LIMIT 1');
    const secretKey = result.rows[0]?.turnstile_secret_key;

    // 2. If no secret key is configured, skip verification (fails open/inactive)
    if (!secretKey) {
      return true;
    }

    // 3. If secret key is set but no token is provided, fail
    if (!token) {
      throw new Error('Verification required. Please complete the CAPTCHA.');
    }

    // 4. Verify with Cloudflare
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
      }),
    });

    const outcome = await response.json();

    if (!outcome.success) {
      console.error('[Turnstile] Verification failed:', outcome['error-codes']);
      throw new Error('Security verification failed. Please try again.');
    }

    return true;
  } catch (error) {
    if (error.message.includes('CAPTCHA') || error.message.includes('Security verification')) {
      throw error;
    }
    console.error('[Turnstile] Error during verification:', error);
    // In case of network errors to Cloudflare, we might want to fail open or closed.
    // Given it's a security feature, failing closed (throwing) is safer, 
    // but might lock users out if Cloudflare is down.
    // For now, we'll throw to be safe.
    throw new Error('Unable to verify security token. Please try again later.');
  }
}
