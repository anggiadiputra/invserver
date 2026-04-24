import pool from './db/pool.js';

async function checkTables() {
  try {
    console.log('--- INVOICES (Last 10) ---');
    const invRes = await pool.query('SELECT id, user_id, invoice_number, invoice_type, system_ref_id FROM invoices ORDER BY id DESC LIMIT 10');
    console.table(invRes.rows);

    console.log('\n--- INVOICE ITEMS (Last 10) ---');
    const itemRes = await pool.query(`
      SELECT ii.id, ii.invoice_id, ii.description, i.invoice_type 
      FROM invoice_items ii 
      JOIN invoices i ON ii.invoice_id = i.id 
      ORDER BY ii.id DESC 
      LIMIT 10
    `);
    console.table(itemRes.rows);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkTables();
