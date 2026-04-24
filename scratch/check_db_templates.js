import pool from './src/db/pool.js';

async function checkTemplates() {
  try {
    const res = await pool.query(
      'SELECT user_id, wa_invoice_template, wa_paid_template, wa_reminder_template FROM company_settings'
    );
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

checkTemplates();
