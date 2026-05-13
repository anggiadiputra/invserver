import dotenv from 'dotenv';
dotenv.config();
import pool from '../src/db/pool.js';

async function fix() {
  try {
    // Check sini@diurusin.id role
    const res = await pool.query("SELECT id, email, role FROM users WHERE email = 'sini@diurusin.id'");
    if (res.rows.length === 0) {
      console.log('User sini@diurusin.id not found.');
      process.exit(0);
    }
    const user = res.rows[0];
    console.log('Current:', user);

    if (user.role === 'admin') {
      // Fix: downgrade to member
      await pool.query("UPDATE users SET role = 'member' WHERE email = 'sini@diurusin.id'");
      console.log("✅ Role changed from 'admin' to 'member' for sini@diurusin.id");
    } else {
      console.log(`Role is already '${user.role}', no fix needed.`);
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}
fix();
