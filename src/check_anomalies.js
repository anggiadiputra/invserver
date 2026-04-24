import pool from './db/pool.js';

async function checkAnomalies() {
  try {
    console.log('--- Checking for System items in Regular Invoices ---');
    const res1 = await pool.query(`
      SELECT i.id, i.invoice_number, ii.description 
      FROM invoices i 
      JOIN invoice_items ii ON i.id = ii.invoice_id 
      WHERE i.invoice_type = 'regular' AND ii.description ILIKE '%topup%'
    `);
    console.table(res1.rows);

    console.log('\n--- Checking for Regular items in System Invoices ---');
    const res2 = await pool.query(`
      SELECT i.id, i.invoice_number, ii.description 
      FROM invoices i 
      JOIN invoice_items ii ON i.id = ii.invoice_id 
      WHERE i.invoice_type != 'regular' AND ii.description NOT ILIKE '%topup%' AND ii.description NOT ILIKE '%subs%'
    `);
    console.table(res2.rows);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkAnomalies();
