import pool from '../db/pool.js';
import { sendSystemInvoiceNotifications } from './notifications.js';

/**
 * Generates a system invoice for a top-up or subscription transaction.
 */
export async function generateSystemInvoice(userId, type, amount, description, refId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Generate unique invoice number
    // Format: TOPUP-YYYYMMDD-REF, SUBS-YYYYMMDD-REF, or REFUND-YYYYMMDD-REF
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let prefix = 'SYS';
    if (type === 'topup') prefix = 'TOPUP';
    else if (type === 'subscription') prefix = 'SUBS';
    else if (type === 'refund') prefix = 'REFUND';
    
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const invoiceNumber = `${prefix}-${dateStr}-${randomSuffix}`;

    // 2. Create System Invoice Record (Automatically PAID)
    const invoiceResult = await client.query(
      `INSERT INTO system_invoices (
        user_id, invoice_number, issue_date, 
        total_amount, status, system_type, system_ref_id, notes
      ) VALUES ($1, $2, CURRENT_DATE, $3, 'paid', $4, $5, $6)
      RETURNING *`,
      [
        userId,
        invoiceNumber,
        amount,
        type,
        refId,
        `Kwitansi otomatis untuk ${description}`,
      ]
    );

    const invoice = invoiceResult.rows[0];

    // 4. Create System Invoice Item
    await client.query(
      `INSERT INTO system_invoice_items (system_invoice_id, description, amount)
       VALUES ($1, $2, $3)`,
      [invoice.id, description, amount]
    );

    await client.query('COMMIT');
    console.log(`[SystemInvoice] Generated ${invoiceNumber} for User ${userId} (New Table)`);

    // 5. Link to wallet transaction if refId matches
    if (refId) {
      await pool.query(
        'UPDATE wallet_transactions SET system_invoice_id = $1 WHERE user_id = $2 AND pakasir_order_id = $3',
        [invoice.id, userId, refId]
      );
    }

    // 6. Trigger notifications (Email/WhatsApp)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    sendSystemInvoiceNotifications(invoice.id, userId, frontendUrl).catch((err) => {
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
