import pool from '../db/pool.js';
import { sendInvoiceNotifications } from './notifications.js';

/**
 * Ensures a 'Self' customer exists for the user.
 * This record is used as the 'customer' for platform invoices (Top-up, Subscription).
 */
async function getOrCreateSelfCustomer(userId) {
  // 1. Try to find existing self customer
  const existing = await pool.query(
    'SELECT id FROM customers WHERE user_id = $1 AND is_self = true LIMIT 1',
    [userId]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // 2. Not found, create one based on company settings or user info
  const companyResult = await pool.query('SELECT * FROM company_settings WHERE user_id = $1 LIMIT 1', [userId]);
  const userResult = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
  
  const company = companyResult.rows[0] || {};
  const user = userResult.rows[0] || {};

  const name = company.company_name || `${user.first_name} ${user.last_name}`;
  const email = company.company_email || user.email;
  const phone = company.company_phone || '';
  const address = company.company_address || '';

  const insertResult = await pool.query(
    `INSERT INTO customers (user_id, name, email, phone, address, is_self) 
     VALUES ($1, $2, $3, $4, $5, true) 
     RETURNING id`,
    [userId, name, email, phone, address]
  );

  return insertResult.rows[0].id;
}

/**
 * Generates a system invoice for a top-up or subscription transaction.
 */
export async function generateSystemInvoice(userId, type, amount, description, refId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get or create self customer
    const customerId = await getOrCreateSelfCustomer(userId);

    // 2. Generate unique invoice number
    // Format: TOPUP-YYYYMMDD-REF or SUBS-YYYYMMDD-REF
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = type === 'topup' ? 'TOPUP' : 'SUBS';
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const invoiceNumber = `${prefix}-${dateStr}-${randomSuffix}`;

    // 3. Create Invoice Record (Automatically PAID)
    const invoiceResult = await client.query(
      `INSERT INTO invoices (
        user_id, customer_id, invoice_number, issue_date, due_date, 
        total_amount, tax_amount, paid_amount, status, invoice_type, system_ref_id, notes
      ) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE, $4, 0, $4, 'paid', $5, $6, $7)
      RETURNING *`,
      [userId, customerId, invoiceNumber, amount, type, refId, `Invoice otomatis untuk ${description}`]
    );

    const invoice = invoiceResult.rows[0];

    // 4. Create Invoice Item
    await client.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, tax_rate)
       VALUES ($1, $2, 1, $3, 0)`,
      [invoice.id, description, amount]
    );

    await client.query('COMMIT');
    console.log(`[SystemInvoice] Generated ${invoiceNumber} for User ${userId}`);

    // 5. Link to wallet transaction if refId matches (Top-up) or recently created
    if (refId) {
      await pool.query(
        'UPDATE wallet_transactions SET invoice_id = $1 WHERE user_id = $2 AND pakasir_order_id = $3',
        [invoice.id, userId, refId]
      );
    }

    // 6. Trigger notifications (Email/WhatsApp)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    sendInvoiceNotifications(invoice.id, userId, frontendUrl).catch(err => {
      console.error('[SystemInvoice] Notification failed:', err);
    });

    return { ...invoice, invoice_number: invoiceNumber };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[SystemInvoice] Failed to generate invoice:', error);
    throw error;
  } finally {
    client.release();
  }
}
