import pool from '../db/pool.js';
import fonnteService from '../services/fonnte.js';
import emailService from '../services/email.js';

/**
 * Automatically send notifications (WhatsApp & Email) for an invoice
 * @param {number} invoiceId - The ID of the invoice
 * @param {number} userId - The ID of the user (sender)
 * @param {string} [baseUrl] - Base URL for public links
 */
export async function sendInvoiceNotifications(invoiceId, userId, baseUrl = 'http://localhost:5173') {
  try {
    // 1. Fetch data
    const invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [invoiceId, userId]);
    if (invoiceResult.rows.length === 0) return;
    const invoice = invoiceResult.rows[0];

    const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
    if (customerResult.rows.length === 0) return;
    const customer = customerResult.rows[0];

    const settingsResult = await pool.query('SELECT * FROM company_settings WHERE user_id = $1', [userId]);
    const company = settingsResult.rows[0] || {};
    
    // Fetch global system settings for integrations (Fonnte, SMTP, etc)
    const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
    const systemSettings = systemResult.rows[0] || {};
    
    const publicUrl = `${baseUrl}/public/invoice/${invoice.invoice_number}`;
    const formatRupiah = (amount) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
    const formatDate = (date) => new Date(date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });

    const replacements = {
      '{customer_name}': customer.name || 'Bapak/Ibu',
      '{company_name}': company.company_name || 'Kami',
      '{invoice_number}': invoice.invoice_number,
      '{issue_date}': formatDate(invoice.issue_date),
      '{due_date}': formatDate(invoice.due_date),
      '{total_amount}': formatRupiah(invoice.total_amount),
      '{public_invoice_url}': publicUrl
    };

    const applyReplacements = (tpl) => {
      let result = tpl;
      Object.entries(replacements).forEach(([key, val]) => {
        result = result.replace(new RegExp(key, 'g'), val);
      });
      return result;
    };

    // --- WHATSAPP LOGIC ---
    // Use system-wide Fonnte token
    if (systemSettings.fonnte_token && customer.phone) {
      // Use system-wide templates if available
      let waTpl = systemSettings.wa_invoice_template;
      if (invoice.status === 'paid' && systemSettings.wa_paid_template) waTpl = systemSettings.wa_paid_template;
      else if ((invoice.status === 'overdue' || invoice.status === 'sent') && systemSettings.wa_reminder_template) waTpl = systemSettings.wa_reminder_template;

      if (waTpl) {
        const message = applyReplacements(waTpl);
        fonnteService.sendTextMessage({
          token: systemSettings.fonnte_token,
          target: customer.phone,
          message,
          countryCode: '62'
        }).then(res => {
          if (res.success) {
            pool.query('INSERT INTO whatsapp_logs (user_id, target, message_type, invoice_id, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())',
              [userId, customer.phone, 'invoice_auto', invoiceId, 'sent']);
          }
        }).catch(err => console.error('Auto WA Error:', err));
      }
    }

    // --- EMAIL LOGIC ---
    // Use system-wide SMTP settings
    if (systemSettings.smtp_host && systemSettings.smtp_user && systemSettings.smtp_pass && customer.email) {
      // Use system-wide templates if available
      let emailTpl = systemSettings.email_invoice_template;
      let subject = `Invoice ${invoice.invoice_number} - ${company.company_name || 'Billing'}`;

      if (invoice.status === 'paid' && systemSettings.email_paid_template) {
        emailTpl = systemSettings.email_paid_template;
        subject = `Pembayaran Diterima - Invoice ${invoice.invoice_number}`;
      } else if ((invoice.status === 'overdue' || invoice.status === 'sent') && systemSettings.email_reminder_template) {
        emailTpl = systemSettings.email_reminder_template;
        subject = `Pengingat Pembayaran - Invoice ${invoice.invoice_number}`;
      }

      if (emailTpl) {
        const html = applyReplacements(emailTpl);
        // We pass systemSettings here for SMTP config
        emailService.sendEmail(systemSettings, {
          to: customer.email,
          subject,
          html
        }).then(res => {
          if (res.success) {
            pool.query('INSERT INTO email_logs (user_id, recipient, subject, invoice_id, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())',
              [userId, customer.email, subject, invoiceId, 'sent']);
          }
        }).catch(err => console.error('Auto Email Error:', err));
      }
    }

  } catch (error) {
    console.error('Error in sendInvoiceNotifications:', error);
  }
}
