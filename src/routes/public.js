import express from 'express';
import pool from '../db/pool.js';

const router = express.Router();

// Get public invoice details (no auth required)
router.get('/invoices/:id', async (req, res) => {
  try {
    const identifier = req.params.id;
    let invoiceResult;

    // Check if identifier is numeric (ID) or string (Invoice Number)
    let isSystem = false;
    if (!isNaN(identifier) && !isNaN(parseFloat(identifier))) {
      invoiceResult = await pool.query('SELECT * FROM invoices WHERE id = $1', [identifier]);
      if (invoiceResult.rows.length === 0) {
        invoiceResult = await pool.query('SELECT * FROM system_invoices WHERE id = $1', [identifier]);
        isSystem = true;
      }
    } else {
      invoiceResult = await pool.query('SELECT * FROM invoices WHERE invoice_number = $1', [identifier]);
      if (invoiceResult.rows.length === 0) {
        invoiceResult = await pool.query('SELECT * FROM system_invoices WHERE invoice_number = $1', [identifier]);
        isSystem = true;
      }
    }

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceResult.rows[0];

    // Get items based on invoice type
    const itemsTable = isSystem ? 'system_invoice_items' : 'invoice_items';
    const itemsFk = isSystem ? 'system_invoice_id' : 'invoice_id';
    
    const itemsResult = await pool.query(`SELECT * FROM ${itemsTable} WHERE ${itemsFk} = $1`, [
      invoice.id,
    ]);

    invoice.items = itemsResult.rows;
    invoice.is_system = isSystem;

    // 1. Get Sender Info (The party issuing the invoice)
    if (isSystem) {
      // For system invoices, the sender is the Platform Admin
      // Fetch admin's company settings and global app name
      const adminResult = await pool.query(
        "SELECT cs.* FROM company_settings cs JOIN users u ON cs.user_id = u.id WHERE u.role = 'admin' LIMIT 1"
      );
      const systemResult = await pool.query('SELECT app_name, company_logo FROM system_settings LIMIT 1');
      
      const admin = adminResult.rows[0];
      const sys = systemResult.rows[0] || { app_name: 'JetBills' };
      
      invoice.sender = {
        name: admin?.company_name || sys.app_name,
        logo: admin?.company_logo || sys.company_logo,
        address: admin?.company_address || 'Invoice Platform Service',
        email: admin?.company_email || 'billing@invoice.id',
        phone: admin?.company_phone || '-'
      };
    } else {
      // For regular invoices, the sender is the user's company profile
      const senderResult = await pool.query('SELECT * FROM company_settings WHERE user_id = $1', [invoice.user_id]);
      const s = senderResult.rows[0];
      if (s) {
        invoice.sender = {
          name: s.company_name,
          logo: s.company_logo,
          address: s.company_address,
          email: s.company_email,
          phone: s.company_phone
        };
      }
    }

    // 2. Get Customer Info (The party receiving the invoice)
    if (isSystem) {
      // For system invoices, the 'customer' is the user themselves
      const userResult = await pool.query(
        `SELECT cs.*, u.email as user_email, u.first_name, u.last_name 
         FROM company_settings cs 
         JOIN users u ON cs.user_id = u.id 
         WHERE u.id = $1`,
        [invoice.user_id]
      );
      
      const u = userResult.rows[0];
      if (u) {
        invoice.customer = {
          name: u.company_name || `${u.first_name} ${u.last_name}`,
          email: u.company_email || u.user_email,
          phone: u.company_phone || '',
          address: u.company_address || '',
          city: u.company_city || '',
        };
      }
    } else if (invoice.customer_id) {
      const customerResult = await pool.query('SELECT * FROM customers WHERE id = $1', [
        invoice.customer_id,
      ]);
      invoice.customer = customerResult.rows[0];
    }

    // 3. Get Bank Accounts
    // For system invoices, we show Admin's bank accounts
    let targetUserIdForBank = invoice.user_id;
    if (isSystem) {
      const adminIdResult = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
      targetUserIdForBank = adminIdResult.rows[0]?.id || 1;
    }

    const bankResult = await pool.query(
      'SELECT bank_name, account_name, account_number, is_primary FROM bank_accounts WHERE user_id = $1 ORDER BY is_primary DESC',
      [targetUserIdForBank]
    );
    invoice.bank_accounts = bankResult.rows;

    // And also services names if needed
    if (!isSystem) {
      const servicesResult = await pool.query('SELECT id, name FROM services WHERE id = ANY($1)', [
        invoice.items.map((item) => item.service_id).filter((id) => id !== null),
      ]);
      invoice.services = servicesResult.rows;
    } else {
      invoice.services = [];
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
    const systemResult = await pool.query(
      'SELECT app_name, company_logo, turnstile_site_key FROM system_settings LIMIT 1'
    );
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
      ...companySettings,
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

export default router;
