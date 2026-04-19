import pool from '../db/pool.js';
import fonnteService from '../services/fonnte.js';

/**
 * Automatically send WhatsApp notification for an invoice
 * @param {number} invoiceId - The ID of the invoice
 * @param {number} userId - The ID of the user (sender)
 * @param {string} [baseUrl] - Base URL for public links
 * @returns {Promise<object>} Result of the sending operation
 */
export async function sendInvoiceWhatsApp(invoiceId, userId, baseUrl = 'http://localhost:5173') {
  try {
    // 1. Fetch Invoice
    const invoiceResult = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, userId]
    );

    if (invoiceResult.rows.length === 0) return { success: false, message: 'Invoice not found' };
    const invoice = invoiceResult.rows[0];

    // 2. Fetch Customer
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [invoice.customer_id]
    );
    if (customerResult.rows.length === 0) return { success: false, message: 'Customer not found' };
    const customer = customerResult.rows[0];
    const customerPhone = customer.phone;

    if (!customerPhone) return { success: false, message: 'Customer phone is empty' };

    // 3. Fetch Global System Settings (Fonnte is now global)
    const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
    const systemSettings = systemResult.rows[0] || {};
    const token = systemSettings.fonnte_token;

    // Fetch Company Settings (for template and branding)
    const settingsResult = await pool.query(
      'SELECT company_name, company_phone, wa_invoice_template, wa_paid_template, wa_reminder_template FROM company_settings WHERE user_id = $1',
      [userId]
    );
    const company = settingsResult.rows[0] || {};

    if (!token) return { success: false, message: 'WhatsApp token not configured' };

    // Selection logic for templates (Priority: Company -> System)
    let tpl = company.wa_invoice_template || systemSettings.wa_invoice_template;
    if (invoice.status === 'paid') {
      tpl = company.wa_paid_template || systemSettings.wa_paid_template || tpl;
    } else if (invoice.status === 'overdue' || invoice.status === 'sent') {
      tpl = company.wa_reminder_template || systemSettings.wa_reminder_template || tpl;
    }

    // 4. Fetch Items
    const itemsResult = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1',
      [invoiceId]
    );
    const items = itemsResult.rows;

    // 5. Build Message (Reuse logic from fonnte.js route)
    const formatRupiah = (amount) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
    const formatDate = (date) => new Date(date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });

    // Message selection is already handled above in the fallback selection

    let message = '';
    const publicUrl = `${baseUrl}/public/invoice/${invoice.invoice_number}`;

    if (tpl) {
      message = tpl
        .replace(/{customer_name}/g, customer.name || 'Bapak/Ibu')
        .replace(/{company_name}/g, company.company_name || 'Kami')
        .replace(/{invoice_number}/g, invoice.invoice_number)
        .replace(/{issue_date}/g, formatDate(invoice.issue_date))
        .replace(/{due_date}/g, formatDate(invoice.due_date))
        .replace(/{total_amount}/g, formatRupiah(invoice.total_amount))
        .replace(/{public_invoice_url}/g, publicUrl);
    } else {
      // Fallback message
      message = `Yth. ${customer.name || 'Bapak/Ibu'},\n\n`;
      message += `Berikut detail invoice Anda:\n\n`;
      message += `📄 Invoice: ${invoice.invoice_number}\n`;
      message += `📅 Status: ${invoice.status.toUpperCase()}\n`;
      message += `💰 Total: ${formatRupiah(invoice.total_amount)}\n\n`;
      message += `Lihat detail: ${publicUrl}\n\n`;
      message += `Terima kasih,\n${company.company_name || 'Kami'}`;
    }

    // 6. Send via Fonnte
    const result = await fonnteService.sendTextMessage({
      token,
      target: customerPhone,
      message,
      countryCode: '62',
      delay: 2
    });

    if (result.success) {
      // Log successful send
      await pool.query(
        'INSERT INTO whatsapp_logs (user_id, target, message_type, invoice_id, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())',
        [userId, customerPhone, 'invoice_auto', invoiceId, 'sent']
      );
    }

    return result;
  } catch (error) {
    console.error('Error in sendInvoiceWhatsApp:', error);
    return { success: false, message: error.message };
  }
}
