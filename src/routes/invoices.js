import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendInvoiceNotifications } from '../utils/notifications.js';
import { calculateInvoiceTotals } from '../utils/calculations.js';

const router = express.Router();

// Get all invoices (supports pagination via ?page=&limit=&status=&search=)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page, limit, status, search } = req.query;

    const conditions = ['i.user_id = $1'];
    const params = [req.userId];
    let paramIdx = 2;

    if (status) {
      conditions.push(`i.status = $${paramIdx++}`);
      params.push(status);
    }
    if (search) {
      conditions.push(`(c.name ILIKE $${paramIdx} OR i.invoice_number ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');
    const baseQuery = `
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE ${whereClause}`;

    if (page && limit) {
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const [dataResult, countResult] = await Promise.all([
        pool.query(
          `SELECT i.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                  (i.total_amount + COALESCE(i.tax_amount, 0)) as grand_total
           ${baseQuery} ORDER BY i.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, limitNum, offset]
        ),
        pool.query(`SELECT COUNT(*) ${baseQuery}`, params)
      ]);

      const total = parseInt(countResult.rows[0].count);
      return res.json({
        data: dataResult.rows,
        pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) }
      });
    }

    // No pagination – return all (backwards compatible)
    const result = await pool.query(
      `SELECT i.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
              (i.total_amount + COALESCE(i.tax_amount, 0)) as grand_total
       ${baseQuery} ORDER BY i.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// Get invoice statistics
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_invoices,
        COALESCE(SUM(total_amount + COALESCE(tax_amount, 0)), 0) as total_income,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN (total_amount + COALESCE(tax_amount, 0)) ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status != 'paid' THEN (total_amount + COALESCE(tax_amount, 0)) ELSE 0 END), 0) as total_pending
       FROM invoices 
       WHERE user_id = $1`,
      [req.userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get monthly statistics for chart (Paid vs Unpaid)
router.get('/stats/monthly', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        TO_CHAR(issue_date, 'Mon') as month,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN (total_amount + COALESCE(tax_amount, 0)) ELSE 0 END), 0) as paid_amount,
        COALESCE(SUM(CASE WHEN status != 'paid' THEN (total_amount + COALESCE(tax_amount, 0)) ELSE 0 END), 0) as unpaid_amount
       FROM invoices 
       WHERE user_id = $1 
         AND issue_date >= CURRENT_DATE - INTERVAL '6 months'
       GROUP BY TO_CHAR(issue_date, 'Mon'), DATE_TRUNC('month', issue_date)
       ORDER BY DATE_TRUNC('month', issue_date) ASC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching monthly statistics:', error);
    res.status(500).json({ error: 'Failed to fetch monthly statistics' });
  }
});

// Create invoice
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { customer_id, invoice_number, issue_date, due_date, items, notes, show_discount, show_unit, show_tax } = req.body;

    if (!customer_id || !invoice_number) {
      return res.status(400).json({ error: 'Customer and invoice number are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Calculate totals using utility
      const { totalAmount, taxAmount } = calculateInvoiceTotals(items, {
        show_discount: !!show_discount,
        show_tax: !!show_tax
      });

      // Create invoice with display preferences
      const invoiceResult = await client.query(
        `INSERT INTO invoices (user_id, customer_id, invoice_number, issue_date, due_date, total_amount, tax_amount, notes, status, show_discount, show_unit, show_tax)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [req.userId, customer_id, invoice_number, issue_date, due_date, totalAmount, taxAmount, notes, 'draft', show_discount || false, show_unit || false, show_tax || false]
      );

      const invoice = invoiceResult.rows[0];

      // Create invoice items
      if (items && items.length > 0) {
        for (const item of items) {
          await client.query(
            `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, tax_rate, discount, unit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [invoice.id, item.service_id, item.description, item.quantity, item.unit_price, item.tax_rate || 0, item.discount || 0, item.unit || null]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json(invoice);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Get invoice by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const identifier = req.params.id;
    let invoiceResult;

    if (!isNaN(identifier) && !isNaN(parseFloat(identifier))) {
      invoiceResult = await pool.query(
        'SELECT * FROM invoices WHERE id = $1 AND user_id = $2',
        [identifier, req.userId]
      );
    } else {
      invoiceResult = await pool.query(
        'SELECT * FROM invoices WHERE invoice_number = $1 AND user_id = $2',
        [identifier, req.userId]
      );
    }

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const itemsResult = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1',
      [invoiceResult.rows[0].id]
    );

    const invoice = invoiceResult.rows[0];
    invoice.items = itemsResult.rows;

    res.json(invoice);
  } catch (error) {
    console.error('Error fetching invoice:', error);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// Update invoice status
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;

    const result = await pool.query(
      'UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = result.rows[0];

    // Trigger automatic notifications if status is paid or sent
    if (status === 'paid' || status === 'sent') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      sendInvoiceNotifications(invoice.id, req.userId, frontendUrl).catch(err => {
        console.error('Failed to send auto-notifications:', err);
      });
    }

    res.json(invoice);
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// Update invoice
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { customer_id, invoice_number, issue_date, due_date, items, notes, status, show_discount, show_unit, show_tax } = req.body;

    if (!customer_id || !invoice_number) {
      return res.status(400).json({ error: 'Customer and invoice number are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Calculate totals using utility
      const { totalAmount, taxAmount } = calculateInvoiceTotals(items, {
        show_discount: !!show_discount,
        show_tax: !!show_tax
      });

      // Update invoice with display preferences
      let query = `
        UPDATE invoices 
        SET customer_id = $1, invoice_number = $2, issue_date = $3, due_date = $4, 
            total_amount = $5, tax_amount = $6, notes = $7, status = $8, updated_at = CURRENT_TIMESTAMP,
            show_discount = $9, show_unit = $10, show_tax = $11
        WHERE id = $12 AND user_id = $13
        RETURNING *
      `;
      let params = [customer_id, invoice_number, issue_date, due_date, totalAmount, taxAmount, notes, status || 'draft', show_discount || false, show_unit || false, show_tax || false, req.params.id, req.userId];

      if (isNaN(req.params.id)) {
        query = `
          UPDATE invoices 
          SET customer_id = $1, invoice_number = $2, issue_date = $3, due_date = $4, 
              total_amount = $5, tax_amount = $6, notes = $7, status = $8, updated_at = CURRENT_TIMESTAMP,
              show_discount = $9, show_unit = $10, show_tax = $11
          WHERE invoice_number = $12 AND user_id = $13
          RETURNING *
        `;
      }

      const invoiceResult = await client.query(query, params);

      if (invoiceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invoice not found' });
      }

      const invoice = invoiceResult.rows[0];

      // Delete old items
      await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [invoice.id]);

      // Create new items
      if (items && items.length > 0) {
        for (const item of items) {
          await client.query(
            `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, tax_rate, discount, unit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [invoice.id, item.service_id, item.description, item.quantity, item.unit_price, item.tax_rate || 0, item.discount || 0, item.unit || null]
          );
        }
      }

      await client.query('COMMIT');

      // Trigger automatic notifications if status is paid or sent
      if (status === 'paid' || status === 'sent') {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        sendInvoiceNotifications(invoice.id, req.userId, baseUrl).catch(err => {
          console.error('Failed to send auto-notifications:', err);
        });
      }

      res.json(invoice);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating invoice:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// Batch delete invoices
router.post('/batch-delete', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid IDs array is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Delete invoice items first (cascade handles this usually, but being safe)
      await client.query('DELETE FROM invoice_items WHERE invoice_id = ANY($1::int[])', [ids]);
      // Delete invoices
      await client.query('DELETE FROM invoices WHERE id = ANY($1::int[]) AND user_id = $2', [ids, req.userId]);
      await client.query('COMMIT');
      res.json({ message: `${ids.length} invoices deleted successfully` });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error batch deleting invoices:', error);
    res.status(500).json({ error: 'Failed to batch delete invoices' });
  }
});

// Batch update invoice status
router.post('/batch-status', authMiddleware, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !status) {
      return res.status(400).json({ error: 'Valid IDs array and status are required' });
    }

    const result = await pool.query(
      'UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($2::int[]) AND user_id = $3 RETURNING id',
      [status, ids, req.userId]
    );

    // Trigger auto-notifications for paid/sent status (limited to avoid spam)
    if (status === 'paid' || status === 'sent') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      for (const row of result.rows) {
        sendInvoiceNotifications(row.id, req.userId, frontendUrl).catch(err => {
          console.error(`Failed auto-notify for invoice ${row.id}:`, err);
        });
      }
    }

    res.json({ message: `${result.rowCount} invoices updated successfully` });
  } catch (error) {
    console.error('Error batch updating invoice status:', error);
    res.status(500).json({ error: 'Failed to batch update invoices' });
  }
});

// Delete invoice
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete invoice items first (cascade will handle this, but being explicit)
      await client.query(
        'DELETE FROM invoice_items WHERE invoice_id = $1',
        [req.params.id]
      );

      // Delete invoice
      const result = await client.query(
        'DELETE FROM invoices WHERE id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.userId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invoice not found' });
      }

      await client.query('COMMIT');
      res.json({ message: 'Invoice deleted successfully' });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error deleting invoice:', error);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

export default router;
