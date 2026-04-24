import pool from './db/pool.js';

async function checkDataLeakage() {
  try {
    console.log('--- Checking for Customer/Invoice UserID Mismatch ---');
    const res = await pool.query(`
      SELECT i.id as invoice_id, i.invoice_number, i.user_id as inv_user, c.user_id as cust_user 
      FROM invoices i 
      JOIN customers c ON i.customer_id = c.id 
      WHERE i.user_id != c.user_id
    `);
    
    if (res.rows.length > 0) {
      console.log('⚠️ DATA LEAKAGE DETECTED!');
      console.table(res.rows);
    } else {
      console.log('✅ No leakage between Invoice and Customer user_id found.');
    }

    console.log('\n--- Checking for Service/Invoice Item UserID Mismatch ---');
    const res2 = await pool.query(`
      SELECT ii.id as item_id, i.user_id as inv_user, s.user_id as svc_user 
      FROM invoice_items ii 
      JOIN invoices i ON ii.invoice_id = i.id 
      JOIN services s ON ii.service_id = s.id 
      WHERE i.user_id != s.user_id
    `);

    if (res2.rows.length > 0) {
      console.log('⚠️ DATA LEAKAGE DETECTED IN SERVICES!');
      console.table(res2.rows);
    } else {
      console.log('✅ No leakage between Service and Invoice user_id found.');
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkDataLeakage();
