import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

async function setupUser() {
  const email = 'lajudigital.com@gmail.com';
  const password = 'password123';

  try {
    const hash = await bcrypt.hash(password, 10);

    // Check if exists
    const check = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (check.rows.length > 0) {
      console.log('User already exists, updating password...');
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hash,
        check.rows[0].id,
      ]);
    } else {
      console.log('Creating new user...');
      const res = await pool.query(
        'INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES (LOWER($1), $2, $3, $4, $5) RETURNING id',
        [email, hash, 'Laju', 'Digital', 'member']
      );

      const userId = res.rows[0].id;

      // Initialize SaaS requirements
      const freePlan = await pool.query("SELECT id FROM plans WHERE slug = 'free'");
      if (freePlan.rows.length > 0) {
        await pool.query(
          'INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [userId, freePlan.rows[0].id, 'active']
        );
      }
      await pool.query(
        'INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT DO NOTHING',
        [userId]
      );
      await pool.query(
        'INSERT INTO company_settings (user_id, company_name, company_email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [userId, "Laju's Corp", email]
      );

      console.log('User created with ID:', userId);
    }
  } catch (err) {
    console.error('Setup failed:', err.message);
  } finally {
    await pool.end();
  }
}

setupUser();
