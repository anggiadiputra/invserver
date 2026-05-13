import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcryptjs';
import pool from '../src/db/pool.js';

async function restore() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const anggiRes = await client.query("SELECT id FROM users WHERE email = 'anggiadiputra@gmail.com'");
    if (anggiRes.rows.length === 0) { console.log('Not found'); process.exit(1); }
    const oldId = anggiRes.rows[0].id;

    const hashedPassword = await bcrypt.hash('password123', 10);
    const createRes = await client.query(
      "INSERT INTO users (email, password_hash, first_name, last_name, role) VALUES ('sini@diurusin.id', $1, 'Admin', 'Sini', 'admin') RETURNING id",
      [hashedPassword]
    );
    const newId = createRes.rows[0].id;
    console.log('New ID:', newId);

    const updateCust = await client.query('UPDATE customers SET user_id = $1 WHERE user_id = $2', [newId, oldId]);
    console.log('Customers moved:', updateCust.rowCount);
    const updateInv = await client.query('UPDATE invoices SET user_id = $1 WHERE user_id = $2', [newId, oldId]);
    console.log('Invoices moved:', updateInv.rowCount);
    const updateServ = await client.query('UPDATE services SET user_id = $1 WHERE user_id = $2', [newId, oldId]);
    console.log('Services moved:', updateServ.rowCount);

    await client.query('INSERT INTO company_settings (user_id, company_name, company_email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [newId, 'Company', 'sini@diurusin.id']);
    
    const freePlan = await client.query("SELECT id FROM plans WHERE slug = 'free'");
    if (freePlan.rows.length > 0) {
      await client.query('INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [newId, freePlan.rows[0].id, 'active']);
    }
    await client.query('INSERT INTO user_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT DO NOTHING', [newId]);

    await client.query('COMMIT');
    console.log('DONE');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    process.exit(1);
  }
}

restore();
