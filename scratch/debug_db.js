import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function debug() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users'
    `);
    console.log('--- Users Table Columns ---');
    console.table(res.rows);
    
    const users = await pool.query('SELECT id, email, first_name, clerk_id FROM users');
    console.log('--- Current Users ---');
    console.table(users.rows);
    
  } catch (err) {
    console.error('Debug error:', err.message);
  } finally {
    await pool.end();
  }
}

debug();
