import express from 'express';
import pool from '../db/pool.js';

const router = express.Router();

// Get public invoice details (no auth required)
router.get('/invoices/:id', async (req, res) => {
  try {
    const identifier = req.params.id;
    let invoiceResult;
    
    // Check if identifier is numeric (ID) or string (Invoice Number)
    if (!isNaN(identifier) && !isNaN(parseFloat(identifier))) {
      invoiceResult = await pool.query(
        'SELECT * FROM invoices WHERE id = $1',
        [identifier]
      );
    } else {
      invoiceResult = await pool.query(
        'SELECT * FROM invoices WHERE invoice_number = $1',
        [identifier]
      );
    }

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.rows[0];

    // Check if invoice has expired
    if (invoice.expires_at) {
      const expiresAt = new Date(invoice.expires_at);
      const now = new Date();
      
      if (now > expiresAt) {
        return res.status(410).json({ 
          error: 'Invoice link has expired',
          message: 'Link invoice ini sudah kedaluwarsa',
          expires_at: invoice.expires_at
        });
      }
    }

    const itemsResult = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1',
      [invoice.id]
    );

    invoice.items = itemsResult.rows;

    // Get customer details
    if (invoice.customer_id) {
      const customerResult = await pool.query(
        'SELECT * FROM customers WHERE id = $1',
        [invoice.customer_id]
      );
      if (customerResult.rows.length > 0) {
        invoice.customer = customerResult.rows[0];
      }
    }

    res.json(invoice);
  } catch (error) {
    console.error('Error fetching public invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// Get company settings (public branding)
router.get('/settings', async (req, res) => {
  try {
    // Fetch global system settings (app name and logo)
    const systemResult = await pool.query('SELECT app_name, company_logo, turnstile_site_key FROM system_settings LIMIT 1');
    const systemSettings = systemResult.rows[0] || { app_name: 'Invoizes' };

    // Get basic company info (fallback for public view)
    const companyResult = await pool.query(
      'SELECT company_name, company_email, company_phone, company_address FROM company_settings LIMIT 1'
    );
    const companySettings = companyResult.rows[0] || {};

    res.json({
      app_name: systemSettings.app_name,
      company_logo: systemSettings.company_logo,
      turnstile_site_key: systemSettings.turnstile_site_key,
      ...companySettings
    });
  } catch (error) {
    console.error('Error fetching public settings:', error);
    res.json({ app_name: 'Invoizes' });
  }
});

// Verify Turnstile token (public pre-flight check)
router.post('/verify-turnstile', async (req, res) => {
  try {
    const { token } = req.body;
    const { verifyTurnstileToken } = await import('../utils/turnstile.js');
    await verifyTurnstileToken(token);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get bank accounts (public)
router.get('/bank-accounts', async (req, res) => {
  try {
    // Get bank accounts for any user (we just need payment info)
    const result = await pool.query(
      'SELECT bank_name, account_name, account_number FROM bank_accounts LIMIT 10'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching public bank accounts:', error);
    res.json([]);
  }
});

// Get services (public)
router.get('/services', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM services LIMIT 100'
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching public services:', error);
    res.json([]);
  }
});

export default router;
