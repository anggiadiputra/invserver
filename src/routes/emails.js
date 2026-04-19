import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import emailService from '../services/email.js';

const router = express.Router();

/**
 * POST /api/emails/send-invoice
 * Send invoice via Email manually
 */
router.post('/send-invoice', authMiddleware, async (req, res) => {
  try {
    const { invoiceId, customMessage, subject: customSubject } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ success: false, message: 'Invoice ID is required' });
    }

    // 1. Fetch data
    const invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [invoiceId, req.userId]);
    if (invoiceResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found' });
    const invoice = invoiceResult.rows[0];

    const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [invoice.customer_id]);
    const customer = customerResult.rows[0];
    if (!customer || !customer.email) return res.status(400).json({ success: false, message: 'Customer email is not set' });

    const companyResult = await pool.query('SELECT * FROM company_settings WHERE user_id = $1', [req.userId]);
    const companySettings = companyResult.rows[0] || {};
    
    // Fetch global system settings as fallback
    const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
    const systemSettings = systemResult.rows[0] || {};

    // Merge settings: User settings take priority, system settings as fallback
    const company = {
      ...systemSettings,
      ...Object.fromEntries(Object.entries(companySettings).filter(([_, v]) => v != null && v !== ''))
    };

    if (!company.smtp_host || !company.smtp_user || !company.smtp_pass) {
      return res.status(400).json({ success: false, message: 'SMTP settings not configured' });
    }

    // 2. Build Message
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const publicUrl = `${frontendUrl}/public/invoice/${invoice.invoice_number}`;
    const formatRupiah = (amount) => `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
    const formatDate = (date) => new Date(date).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' });

    let emailTpl = company.email_invoice_template;
    let subject = customSubject || `Invoice ${invoice.invoice_number} - ${company.company_name || 'Billing'}`;

    if (invoice.status === 'paid' && company.email_paid_template) {
      emailTpl = company.email_paid_template;
      if (!customSubject) subject = `Pembayaran Diterima - Invoice ${invoice.invoice_number}`;
    } else if ((invoice.status === 'overdue' || invoice.status === 'sent') && company.email_reminder_template) {
      emailTpl = company.email_reminder_template;
      if (!customSubject) subject = `Pengingat Pembayaran - Invoice ${invoice.invoice_number}`;
    }

    const replacements = {
      '{customer_name}': customer.name || 'Bapak/Ibu',
      '{company_name}': company.company_name || 'Kami',
      '{invoice_number}': invoice.invoice_number,
      '{issue_date}': formatDate(invoice.issue_date),
      '{due_date}': formatDate(invoice.due_date),
      '{total_amount}': formatRupiah(invoice.total_amount),
      '{public_invoice_url}': publicUrl
    };

    let html = customMessage;
    if (!html) {
      if (emailTpl) {
        html = emailTpl;
        Object.entries(replacements).forEach(([key, val]) => {
          html = html.replace(new RegExp(key, 'g'), val);
        });
      } else {
        // Fallback simple HTML
        html = `<h2>Halo ${replacements['{customer_name}']}</h2>
                <p>Berikut adalah invoice Anda dari ${replacements['{company_name}']}:</p>
                <ul>
                  <li>No. Invoice: ${replacements['{invoice_number}']}</li>
                  <li>Total: ${replacements['{total_amount}']}</li>
                  <li>Jatuh Tempo: ${replacements['{due_date}']}</li>
                </ul>
                <p>Lihat detail invoice di: <a href="${publicUrl}">${publicUrl}</a></p>
                <p>Terima kasih!</p>`;
      }
    }

    // 3. Send Email
    const result = await emailService.sendEmail(company, {
      to: customer.email,
      subject: subject,
      html: html
    });

    // 4. Log the send operation
    await pool.query(
      'INSERT INTO email_logs (user_id, recipient, subject, invoice_id, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [req.userId, customer.email, subject, invoiceId, 'sent']
    );

    res.json({
      success: true,
      message: 'Email sent successfully',
      messageId: result.messageId
    });

  } catch (error) {
    console.error('Manual Email Error:', error);
    res.status(500).json({ success: false, message: 'Failed to send email', error: error.message });
  }
});

/**
 * GET /api/emails/logs
 * Get Email send logs with pagination
 */
router.get('/logs', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM email_logs WHERE user_id = $1',
      [req.userId]
    );
    const totalCount = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT el.*, i.invoice_number 
       FROM email_logs el
       LEFT JOIN invoices i ON el.invoice_id = i.id
       WHERE el.user_id = $1 
       ORDER BY el.sent_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    res.json({
      logs: result.rows,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching Email logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

/**
 * GET /api/emails/logs/:id
 * Get single Email log detail
 */
router.get('/logs/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT el.*, i.invoice_number, c.name as customer_name
       FROM email_logs el
       LEFT JOIN invoices i ON el.invoice_id = i.id
       LEFT JOIN customers c ON i.customer_id = c.id
       WHERE el.id = $1 AND el.user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Log not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching Email log detail:', error);
    res.status(500).json({ error: 'Failed to fetch log detail' });
  }
});

// Batch delete email logs
router.post('/logs/batch-delete', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid IDs array is required' });
    }

    await pool.query(
      'DELETE FROM email_logs WHERE id = ANY($1::int[]) AND user_id = $2',
      [ids, req.userId]
    );

    res.json({ message: `${ids.length} email logs deleted successfully` });
  } catch (error) {
    console.error('Error batch deleting email logs:', error);
    res.status(500).json({ error: 'Failed to batch delete email logs' });
  }
});

export default router;
