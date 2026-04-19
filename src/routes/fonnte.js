import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import fonnteService from '../services/fonnte.js';

const router = express.Router();

/**
 * POST /api/fonnte/test-connection
 * Test Fonnte API connection with token
 */
router.post('/test-connection', authMiddleware, async (req, res) => {
  try {
    const { token, testTarget, testMessage } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token is required',
      });
    }

    console.log('Testing Fonnte connection for user:', req.userId);
    console.log('Test target:', testTarget || 'from database');
    console.log('Test message:', testMessage || 'default');

    // Jika testTarget tidak ada di request, ambil dari database
    let targetToSend = testTarget;
    if (!targetToSend) {
      const settingsResult = await pool.query(
        'SELECT fonnte_test_target FROM company_settings WHERE user_id = $1',
        [req.userId]
      );
      
      if (settingsResult.rows.length > 0 && settingsResult.rows[0].fonnte_test_target) {
        targetToSend = settingsResult.rows[0].fonnte_test_target;
      } else {
        targetToSend = '628123456789'; // Default
      }
    }

    const result = await fonnteService.testConnection(token, targetToSend, testMessage);

    if (result.success) {
      res.json(result);
    } else {
      res.status(401).json(result);
    }
  } catch (error) {
    console.error('Error testing Fonnte connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test connection',
      error: error.message,
    });
  }
});

/**
 * POST /api/fonnte/validate-number
 * Check if a phone number is registered on WhatsApp
 */
router.post('/validate-number', authMiddleware, async (req, res) => {
  try {
    const { target, countryCode } = req.body;

    if (!target) {
      return res.status(400).json({
        success: false,
        message: 'Target phone number is required',
      });
    }

    // Get global Fonnte token from system settings
    const systemResult = await pool.query('SELECT fonnte_token FROM system_settings LIMIT 1');
    
    if (systemResult.rows.length === 0 || !systemResult.rows[0].fonnte_token) {
      return res.status(400).json({
        success: false,
        message: 'Fonnte token not configured by administrator.',
      });
    }

    const token = systemResult.rows[0].fonnte_token;

    console.log('Validating phone number:', target, 'by user:', req.userId);

    const result = await fonnteService.validateNumber(token, target, countryCode);

    res.json(result);
  } catch (error) {
    console.error('Error validating phone number:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate phone number',
      error: error.message,
    });
  }
});

/**
 * POST /api/fonnte/send
 * Send WhatsApp message
 */
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { target, message, countryCode, url, filename, schedule, delay, buttonJSON, templateJSON, listJSON } = req.body;

    // Validation
    if (!target || !message) {
      return res.status(400).json({
        success: false,
        message: 'Target and message are required',
      });
    }

    // Get global Fonnte token from system settings
    const systemResult = await pool.query('SELECT fonnte_token FROM system_settings LIMIT 1');
    
    if (systemResult.rows.length === 0 || !systemResult.rows[0].fonnte_token) {
      return res.status(400).json({
        success: false,
        message: 'Fonnte token not configured by administrator.',
      });
    }

    const token = systemResult.rows[0].fonnte_token;

    console.log('Sending WhatsApp message to:', target, 'by user:', req.userId);

    let result;

    // Determine which method to use based on parameters
    if (buttonJSON) {
      // Send with interactive buttons
      const buttonData = JSON.parse(buttonJSON);
      result = await fonnteService.sendWithButton({
        token,
        target,
        message: buttonData.message || message,
        footer: buttonData.footer || '',
        buttons: buttonData.buttons || [],
        countryCode: countryCode || '62',
      });
    } else if (templateJSON) {
      // Send with template
      const templateData = JSON.parse(templateJSON);
      result = await fonnteService.sendWithTemplate({
        token,
        target,
        message: templateData.message || message,
        footer: templateData.footer || '',
        buttons: templateData.buttons || [],
        countryCode: countryCode || '62',
      });
    } else if (listJSON) {
      // Send with list
      const listData = JSON.parse(listJSON);
      result = await fonnteService.sendWithList({
        token,
        target,
        message: listData.message || message,
        footer: listData.footer || '',
        buttonTitle: listData.buttonTitle || '',
        title: listData.title || '',
        listData: listData.buttons || [],
        countryCode: countryCode || '62',
      });
    } else if (url && filename) {
      // Send with attachment
      result = await fonnteService.sendWithAttachment({
        token,
        target,
        message,
        url,
        filename,
        countryCode: countryCode || '62',
        delay: delay || 2,
      });
    } else {
      // Send text message
      result = await fonnteService.sendTextMessage({
        token,
        target,
        message,
        countryCode: countryCode || '62',
        delay: delay || 2,
      });
    }

    if (result.success) {
      // Log the send operation
      await pool.query(
        'INSERT INTO whatsapp_logs (user_id, target, message_type, status, sent_at) VALUES ($1, $2, $3, $4, NOW())',
        [req.userId, target, buttonJSON ? 'button' : templateJSON ? 'template' : listJSON ? 'list' : url ? 'attachment' : 'text', 'sent']
      );

      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message,
    });
  }
});

/**
 * POST /api/fonnte/send-invoice
 * Send invoice via WhatsApp with template
 */
router.post('/send-invoice', authMiddleware, async (req, res) => {
  try {
    const { invoiceId, customerPhone, countryCode = '62', customMessage, publicUrl } = req.body;

    // Validation
    if (!invoiceId || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: 'Invoice ID and customer phone are required',
      });
    }

    // Get global Fonnte token from system settings
    const systemResult = await pool.query('SELECT fonnte_token FROM system_settings LIMIT 1');
    
    if (systemResult.rows.length === 0 || !systemResult.rows[0].fonnte_token) {
      return res.status(400).json({
        success: false,
        message: 'Fonnte token not configured by administrator.',
      });
    }

    const token = systemResult.rows[0].fonnte_token;

    // Fetch invoice data
    const invoiceResult = await pool.query(
      'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
      [invoiceId, req.userId]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    const invoice = invoiceResult.rows[0];

    // Fetch customer data
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [invoice.customer_id]
    );

    const customer = customerResult.rows[0];

    // Fetch company settings for branding
    const companySettings = await pool.query(
      'SELECT company_name, company_phone, wa_invoice_template FROM company_settings WHERE user_id = $1',
      [req.userId]
    );

    const company = companySettings.rows[0] || {};

    // Fetch invoice items
    const itemsResult = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1',
      [invoiceId]
    );

    const items = itemsResult.rows;

    // Format amounts in Rupiah
    const formatRupiah = (amount) => {
      return `Rp${new Intl.NumberFormat('id-ID').format(Math.round(amount))}`;
    };

    // Format date
    const formatDate = (date) => {
      return new Date(date).toLocaleDateString('id-ID', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    };

    // Build invoice message
    let message = customMessage || '';
    
    if (!customMessage) {
      let tpl = company.wa_invoice_template;
      
      if (invoice.status === 'paid' && company.wa_paid_template) {
        tpl = company.wa_paid_template;
      } else if ((invoice.status === 'overdue' || invoice.status === 'sent') && company.wa_reminder_template) {
        tpl = company.wa_reminder_template;
      }

      if (tpl) {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const generatedUrl = publicUrl || `${frontendUrl}/public/invoice/${invoice.invoice_number}`;
        tpl = tpl.replace(/{customer_name}/g, customer?.name || 'Bapak/Ibu');
        tpl = tpl.replace(/{company_name}/g, company.company_name || 'Kami');
        tpl = tpl.replace(/{invoice_number}/g, invoice.invoice_number);
        tpl = tpl.replace(/{issue_date}/g, formatDate(invoice.issue_date));
        tpl = tpl.replace(/{due_date}/g, formatDate(invoice.due_date));
        tpl = tpl.replace(/{total_amount}/g, formatRupiah(invoice.total_amount));
        tpl = tpl.replace(/{public_invoice_url}/g, generatedUrl);
        message = tpl;
      } else {
        message = `Yth. ${customer?.name || 'Bapak/Ibu'},\n\n`;
      message += `Berikut kami sampaikan invoice dengan detail:\n\n`;
      message += `📄 Invoice: ${invoice.invoice_number}\n`;
      message += `📅 Tanggal: ${formatDate(invoice.issue_date)}\n`;
      message += `💰 Total: ${formatRupiah(invoice.total_amount)}\n`;
      message += `📅 Jatuh Tempo: ${formatDate(invoice.due_date)}\n`;
      message += `📊 Status: ${invoice.status.toUpperCase()}\n\n`;

      if (items.length > 0) {
        message += `Detail item:\n`;
        items.forEach((item, index) => {
          message += `${index + 1}. ${item.description}\n`;
          message += `   ${item.quantity} x ${formatRupiah(item.unit_price)} = ${formatRupiah(item.quantity * item.unit_price)}\n`;
        });
        message += `\n`;
      }

      if (invoice.tax_amount > 0) {
        message += `Pajak: ${formatRupiah(invoice.tax_amount)}\n`;
      }

      if (invoice.notes) {
        message += `\nCatatan: ${invoice.notes}\n`;
      }

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const generatedUrl = publicUrl || `${frontendUrl}/public/invoice/${invoice.invoice_number}`;
      message += `\nLihat detail invoice dan lakukan pembayaran melalui tautan berikut:\n${generatedUrl}\n\n`;
      message += `Mohon pembayaran dapat dilakukan sebelum tanggal jatuh tempo.\n\n`;
      message += `Terima kasih atas kerjasamanya.\n\n`;
      message += `Salam,\n${company.company_name || 'Kami'}\n`;
      message += `${company.company_phone || ''}`;
    }
    }

    console.log('Sending invoice', invoiceId, 'to', customerPhone);

    // Send via Fonnte
    const result = await fonnteService.sendTextMessage({
      token,
      target: customerPhone,
      message,
      countryCode,
      delay: 2,
    });

    if (result.success) {
      // Update invoice status to 'sent'
      await pool.query('UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2', ['sent', invoiceId]);

      // Log the send operation
      await pool.query(
        'INSERT INTO whatsapp_logs (user_id, target, message_type, invoice_id, status, sent_at) VALUES ($1, $2, $3, $4, $5, NOW())',
        [req.userId, customerPhone, 'invoice', invoiceId, 'sent']
      );

      res.json({
        success: true,
        message: 'Invoice sent successfully',
        data: {
          invoice_id: invoiceId,
          target: customerPhone,
          status: 'sent',
          sent_at: new Date().toISOString(),
        },
      });
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error sending invoice:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send invoice',
      error: error.message,
    });
  }
});

/**
 * GET /api/fonnte/logs
 * Get WhatsApp send logs with pagination
 */
router.get('/logs', authMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM whatsapp_logs WHERE user_id = $1',
      [req.userId]
    );
    const totalCount = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT wl.*, i.invoice_number 
       FROM whatsapp_logs wl
       LEFT JOIN invoices i ON wl.invoice_id = i.id
       WHERE wl.user_id = $1 
       ORDER BY wl.sent_at DESC 
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
    console.error('Error fetching WA logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

/**
 * GET /api/fonnte/logs/:id
 * Get single WhatsApp log detail
 */
router.get('/logs/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT wl.*, i.invoice_number, c.name as customer_name
       FROM whatsapp_logs wl
       LEFT JOIN invoices i ON wl.invoice_id = i.id
       LEFT JOIN customers c ON i.customer_id = c.id
       WHERE wl.id = $1 AND wl.user_id = $2`,
      [id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Log not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching WA log detail:', error);
    res.status(500).json({ error: 'Failed to fetch log detail' });
  }
});

export default router;
