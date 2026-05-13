import dotenv from 'dotenv';
dotenv.config();
import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool();

async function check() {
  const res = await pool.query("SELECT * FROM users WHERE email = 'anggiadiputra@gmail.com'");
  console.log("User:", res.rows[0]);
  
  if (res.rows[0]) {
    const id = res.rows[0].id;
    const invs = await pool.query("SELECT id, created_at, user_id FROM invoices WHERE user_id = $1 ORDER BY created_at DESC", [id]);
    console.log(`Invoices count: ${invs.rowCount}`);
    const custs = await pool.query("SELECT id, name, created_at FROM customers WHERE user_id = $1 ORDER BY created_at DESC", [id]);
    console.log(`Customers count: ${custs.rowCount}`);
  }
  process.exit(0);
}
check();
