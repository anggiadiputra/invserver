import express from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import pool from '../db/pool.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';
import emailService from '../services/email.js';
import { verifyTurnstileToken } from '../utils/turnstile.js';

const router = express.Router();

// Validation middleware
// IMPORTANT: gmail_remove_dots: false prevents 'user.name@gmail.com' → 'username@gmail.com'
// which would cause login to fail because the dot-version is stored in DB.
const validateEmail = body('email').isEmail().normalizeEmail({ gmail_remove_dots: false });
const validatePassword = body('password').isLength({ min: 6 }).trim();
const validateName = [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty()
];

// Register
router.post('/register', 
  validateEmail, 
  validatePassword,
  ...validateName,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, firstName, lastName, companyName, turnstileToken } = req.body;
      
      // Verify Turnstile
      try {
        await verifyTurnstileToken(turnstileToken);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      // Check if user exists (case-insensitive)
      const userResult = await pool.query(
        'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (userResult.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user (save email in lowercase)
      const result = await pool.query(
        'INSERT INTO users (email, password_hash, first_name, last_name, company_name, role) VALUES (LOWER($1), $2, $3, $4, $5, $6) RETURNING id, email, first_name, last_name, role, neon_user_id',
        [email, hashedPassword, firstName, lastName, companyName || null, 'member']
      );

      const user = result.rows[0];

      // Ensure user has a company_settings record
      await pool.query(
        'INSERT INTO company_settings (user_id, company_name, company_email) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
        [user.id, companyName || `${firstName}'s Company`, email]
      );

      // --- SAAS ONBOARDING ---
      // 1. Get Free Plan ID
      const freePlanResult = await pool.query("SELECT id FROM plans WHERE slug = 'free'");
      const freePlanId = freePlanResult.rows[0].id;

      // 2. Create 'free' subscription
      await pool.query(
        'INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
        [user.id, freePlanId, 'active']
      );

      // 3. Create wallet with 0 balance
      await pool.query(
        'INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
        [user.id]
      );
      // -----------------------
      const token = generateToken(user.id);

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      res.json({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          neon_user_id: user.neon_user_id,
        },
        token,
      });
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

// Login
router.post('/login',
  validateEmail,
  validatePassword,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, turnstileToken } = req.body;

      // Verify Turnstile
      try {
        await verifyTurnstileToken(turnstileToken);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      // Find user by email (case-insensitive)
      const result = await pool.query(
        'SELECT id, email, password_hash, first_name, last_name, role, neon_user_id FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result.rows[0];

      // If user has no password (registered via Neon Auth / SSO only)
      // they must use Neon Auth to sign in, not the legacy email/password form.
      if (!user.password_hash) {
        return res.status(401).json({ 
          error: 'Akun ini terdaftar melalui Neon Auth. Silakan login menggunakan tombol SSO atau gunakan fitur "Forgot Password" untuk mengatur password.' 
        });
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password_hash);

      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = generateToken(user.id);

      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      res.json({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          neon_user_id: user.neon_user_id,
        },
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Get current user profile (with Wallet and Subscription info)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.email, u.first_name, u.last_name, u.role, u.neon_user_id,
        w.balance as wallet_balance,
        s.id as subscription_id,
        s.status as subscription_status,
        s.expires_at as subscription_expires_at,
        p.name as plan_name,
        p.slug as plan_slug,
        p.price_monthly as plan_price
      FROM users u
      LEFT JOIN user_wallets w ON u.id = w.user_id
      LEFT JOIN subscriptions s ON u.id = s.user_id
      LEFT JOIN plans p ON s.plan_id = p.id
      WHERE u.id = $1
    `, [req.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const row = result.rows[0];
    const isAdmin = row.role === 'admin';

    res.json({
      user: {
        id: row.id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        role: row.role,
        neon_user_id: row.neon_user_id,
        wallet: {
          balance: isAdmin ? 'Unlimited' : (row.wallet_balance || 0)
        },
        subscription: isAdmin ? {
          status: 'active',
          expires_at: null,
          plan: {
            name: 'System Admin',
            slug: 'admin',
            price: 0
          }
        } : {
          id: row.subscription_id,
          status: row.subscription_status,
          expires_at: row.subscription_expires_at,
          plan: {
            name: row.plan_name,
            slug: row.plan_slug,
            price: row.plan_price
          }
        }
      }
    });
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Forgot Password
router.post('/forgot-password', validateEmail, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { email, turnstileToken } = req.body;

    // Verify Turnstile
    try {
      await verifyTurnstileToken(turnstileToken);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, first_name, last_name, company_name FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rows.length === 0) {
      // Return success anyway to prevent email enumeration
      return res.json({ success: true, message: 'Reset link sent if the email exists' });
    }

    const user = result.rows[0];

    // Create a 15-minute token using their password_hash as secret.
    const secret = process.env.JWT_SECRET + user.password_hash;
    const token = jwt.sign({ id: user.id }, secret, { expiresIn: '15m' });

    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}&email=${encodeURIComponent(user.email)}`;

    console.log('\n=============================================');
    console.log('PASSWORD RESET LINK GENERATED');
    console.log(`For User: ${user.email}`);
    console.log(`Link: ${resetUrl}`);
    console.log('=============================================\n');

    try {
      const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
      const systemSettings = systemResult.rows[0];
      if (systemSettings && systemSettings.smtp_host && systemSettings.smtp_user && systemSettings.smtp_pass) {
        await emailService.sendEmail(systemSettings, {
          to: user.email,
          subject: 'Password Reset Request',
          html: `
            <p>Hi ${user.first_name || 'User'},</p>
            <p>You requested to reset your password. Click the link below to set a new password:</p>
            <p><a href="${resetUrl}">Reset Password</a></p>
            <p>This link will expire in 15 minutes.</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
          `
        });
      }
    } catch (emailErr) {
      console.log('Could not send reset email via user SMTP settings. Console link printed above.');
    }

    res.json({ success: true, message: 'Reset link sent if the email exists.' });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// Reset Password
router.post('/reset-password',
  body('email').isEmail().normalizeEmail(),
  validatePassword,
  body('token').notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
         return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, token } = req.body;

      const result = await pool.query(
        'SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired token.' });
      }

      const user = result.rows[0];
      const secret = process.env.JWT_SECRET + user.password_hash;

      try {
        const decoded = jwt.verify(token, secret);
        if (decoded.id !== user.id) {
            throw new Error('UserId mismatch');
        }
      } catch (err) {
        return res.status(400).json({ error: 'Invalid or expired token.' });
      }

      const newHash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newHash, user.id]);

      res.json({ success: true, message: 'Password has been reset successfully.' });

    } catch (error) {
      console.error('Reset password error:', error);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Sync Neon Identity (Triggers authMiddleware's Path A linking logic)
router.post('/sync-neon', authMiddleware, (req, res) => {
  res.json({ success: true, message: 'Identity synced successfully', userId: req.userId });
});

/**
 * POST /api/auth/neon-pre-register
 * Called right after authClient.signUp.email() succeeds on the frontend.
 * Creates a local user record with a password hash so the user can also login
 * via email/password after their Neon Auth session expires.
 * 
 * Security: This endpoint does NOT require Turnstile because it's called immediately
 * after a Turnstile-verified Neon Auth signup. Rate limiting should be used in production.
 */
router.post('/neon-pre-register',
  body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
  body('password').isLength({ min: 6 }).trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, firstName, lastName, companyName } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);

      // Check if user already exists (created by JIT provisioning or previous attempt)
      const existing = await pool.query(
        'SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (existing.rows.length > 0) {
        // User already exists (from JIT or other). Update password if not set.
        const existingUser = existing.rows[0];
        if (!existingUser.password_hash) {
          await pool.query(
            'UPDATE users SET password_hash = $1, first_name = COALESCE(first_name, $2), last_name = COALESCE(last_name, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $4',
            [hashedPassword, firstName || '', lastName || '', existingUser.id]
          );
        }
        return res.json({ success: true, message: 'Local account updated.' });
      }

      // Create new local user
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const insertRes = await client.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, company_name, role)
           VALUES (LOWER($1), $2, $3, $4, $5, 'member') RETURNING id`,
          [email, hashedPassword, firstName || '', lastName || '', companyName || null]
        );
        const userId = insertRes.rows[0].id;

        await client.query(
          'INSERT INTO company_settings (user_id, company_name, company_email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, companyName || `${firstName}'s Company`, email]
        );

        const freePlan = await client.query("SELECT id FROM plans WHERE slug = 'free'");
        if (freePlan.rows.length > 0) {
          await client.query(
            'INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [userId, freePlan.rows[0].id, 'active']
          );
        }

        await client.query(
          'INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT DO NOTHING',
          [userId]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: 'Local account pre-created.', userId });
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Neon pre-register error:', error);
      // Non-fatal: Neon Auth signup succeeded, local provision might retry via JIT
      res.status(500).json({ error: 'Failed to create local account, but Neon Auth registration succeeded.' });
    }
  }
);

export default router;
