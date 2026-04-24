import pg from 'pg';
import 'dotenv/config.js';
const { Pool } = pg;
const pool = new Pool();
async function test() {
  const result = await pool.query('SELECT * FROM users LIMIT 2');
  console.log(result.rows);
}
test()
  .catch(console.error)
  .finally(() => process.exit(0));
