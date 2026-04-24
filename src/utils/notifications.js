import pool from '../db/pool.js';
import fonnteService from '../services/fonnte.js';
import emailService from '../services/email.js';

/**
 * Automatically send notifications (WhatsApp & Email) for an invoice
 * @param {number} invoiceId - The ID of the invoice
 * @param {number} userId - The ID of the user (sender)
 * @param {string} [baseUrl] - Base URL for public links
 */
export async function sendInvoiceNotifications(
  invoiceId,
  userId,
  baseUrl = 'http://localhost:5173'
) {
  try {
    // 1. Fetch invoice data
    const invoiceResult = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, userId]
    );
    if (invoiceResult.rows.length === 0) return;
    const invoice = invoiceResult.rows[0];

    // 2. Fetch customer data
    const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [
      invoice.customer_id,
    ]);
    if (customerResult.rows.length === 0) return;
    const customer = customerResult.rows[0];

    // 3. Fetch sender (user's company) data
    const settingsResult = await pool.query('SELECT * FROM company_settings WHERE user_id = $1', [
      userId,
    ]);
    const company = settingsResult.rows[0] || {};

    // 4. Trigger the shared notification logic
    await processNotifications({
      invoice,
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone
      },
      company,
      userId, // Original sender ID for logging
      baseUrl
    });
  } catch (error) {
    console.error('Error in sendInvoiceNotifications:', error);
  }
}

/**
 * Automatically send notifications for a system-generated invoice (Top-up, Refund, Sub)
 * @param {number} invoiceId - The ID from system_invoices table
 * @param {number} targetUserId - The ID of the user receiving the notification
 * @param {string} [baseUrl] - Base URL for public links
 */
export async function sendSystemInvoiceNotifications(
  invoiceId,
  targetUserId,
  baseUrl = 'http://localhost:5173'
) {
  try {
    // 1. Fetch system invoice data
    const invoiceResult = await pool.query(
      'SELECT * FROM system_invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, targetUserId]
    );
    if (invoiceResult.rows.length === 0) return;
    const invoice = invoiceResult.rows[0];

    // 2. Fetch recipient data (The user themselves)
    const userResult = await pool.query(
      `SELECT cs.*, u.email as user_email, u.first_name, u.last_name 
       FROM company_settings cs 
       JOIN users u ON cs.user_id = u.id 
       WHERE u.id = $1`,
      [targetUserId]
    );
    const u = userResult.rows[0];
    if (!u) return;

    const recipient = {
      name: u.company_name || `${u.first_name} ${u.last_name}`,
      email: u.company_email || u.user_email,
      phone: u.company_phone || ''
    };

    // 3. Fetch sender data (Admin company settings)
    const adminResult = await pool.query(
      "SELECT cs.* FROM company_settings cs JOIN users u ON cs.user_id = u.id WHERE u.role = 'admin' LIMIT 1"
    );
    const company = adminResult.rows[0] || {};

    // 4. Trigger shared notification logic
    await processNotifications({
      invoice: { ...invoice, is_system: true },
      customer: recipient,
      company,
      userId: targetUserId, // We log it under the user's ID
      baseUrl
    });
  } catch (error) {
    console.error('Error in sendSystemInvoiceNotifications:', error);
  }
}

/**
 * Internal helper to process templates and send through multiple channels
 */
async function processNotifications({ invoice, customer, company, userId, baseUrl }) {
  // Fetch global system settings for integrations (Fonnte, SMTP, etc)
  const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
  const systemSettings = systemResult.rows[0] || {};

  const publicUrl = `${baseUrl}/public/invoice/${invoice.invoice_number}`;
  const formatRupiah = (amount) =>
    `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
  const formatDate = (date) =>
    date ? new Date(date).toLocaleDateString('id-ID', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }) : '-';

  const replacements = {
    '{customer_name}': customer.name || 'Bapak/Ibu',
    '{company_name}': company.company_name || 'Kami',
    '{invoice_number}': invoice.invoice_number,
    '{issue_date}': formatDate(invoice.issue_date),
    '{due_date}': formatDate(invoice.due_date || invoice.issue_date),
    '{total_amount}': formatRupiah(invoice.total_amount),
    '{public_invoice_url}': publicUrl,
  };

  const applyReplacements = (tpl) => {
    let result = tpl;
    Object.entries(replacements).forEach(([key, val]) => {
      result = result.replace(new RegExp(key, 'g'), val);
    });
    return result;
  };

  // --- WHATSAPP LOGIC ---
  if (systemSettings.fonnte_token && customer.phone) {
    let waTpl = systemSettings.wa_invoice_template;
    if (invoice.status === 'paid' && systemSettings.wa_paid_template)
      waTpl = systemSettings.wa_paid_template;
    else if (
      (invoice.status === 'overdue' || invoice.status === 'sent') &&
      systemSettings.wa_reminder_template
    )
      waTpl = systemSettings.wa_reminder_template;

    if (waTpl) {
      const message = applyReplacements(waTpl);
      fonnteService
        .sendTextMessage({
          token: systemSettings.fonnte_token,
          target: customer.phone,
          message,
          countryCode: '62',
        })
        .then((res) => {
          if (res.success) {
            const logTable = invoice.is_system ? 'whatsapp_logs' : 'whatsapp_logs'; // Same table
            const fkCol = invoice.is_system ? 'system_invoice_id' : 'invoice_id';
            
            pool.query(
              `INSERT INTO whatsapp_logs (user_id, target, message_type, ${fkCol}, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
              [userId, customer.phone, 'invoice_auto', invoice.id, 'sent']
            );
          }
        })
        .catch((err) => console.error('Auto WA Error:', err));
    }
  }

  // --- EMAIL LOGIC ---
  if (
    systemSettings.smtp_host &&
    systemSettings.smtp_user &&
    systemSettings.smtp_pass &&
    customer.email
  ) {
    let emailTpl = systemSettings.email_invoice_template;
    let subject = `Invoice ${invoice.invoice_number} - ${company.company_name || 'Billing'}`;

    if (invoice.status === 'paid' && systemSettings.email_paid_template) {
      emailTpl = systemSettings.email_paid_template;
      subject = `Pembayaran Diterima - Invoice ${invoice.invoice_number}`;
    } else if (
      (invoice.status === 'overdue' || invoice.status === 'sent') &&
      systemSettings.email_reminder_template
    ) {
      emailTpl = systemSettings.email_reminder_template;
      subject = `Pengingat Pembayaran - Invoice ${invoice.invoice_number}`;
    }

    if (emailTpl) {
      const html = applyReplacements(emailTpl);
      emailService
        .sendEmail(systemSettings, {
          to: customer.email,
          subject,
          html,
        })
        .then((res) => {
          if (res.success) {
            const fkCol = invoice.is_system ? 'system_invoice_id' : 'invoice_id';
            pool.query(
              `INSERT INTO email_logs (user_id, recipient, subject, ${fkCol}, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
              [userId, customer.email, subject, invoice.id, 'sent']
            );
          }
        })
        .catch((err) => console.error('Auto Email Error:', err));
    }
  }
}
