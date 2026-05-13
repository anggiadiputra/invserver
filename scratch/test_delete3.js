import dotenv from 'dotenv';
dotenv.config();
import pool from '../src/db/pool.js';

async function test() {
  try {
    const ids = ["1", "2"]; // simulating string array from frontend
    const userId = 12;
    await pool.query('DELETE FROM customers WHERE id = ANY($1::int[]) AND user_id = $2', [ids, userId]);
    console.log('Success string ids');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}
test();
