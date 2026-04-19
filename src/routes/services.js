import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get all services (supports pagination via ?page=&limit=&search=&status=)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page, limit, status, search } = req.query;

    const conditions = ['user_id = $1'];
    const params = [req.userId];
    let paramIdx = 2;

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    if (search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    if (page && limit) {
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const [dataResult, countResult] = await Promise.all([
        pool.query(
          `SELECT * FROM services WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, limitNum, offset]
        ),
        pool.query(
          `SELECT COUNT(*) FROM services WHERE ${whereClause}`,
          params
        )
      ]);

      const total = parseInt(countResult.rows[0].count);
      return res.json({
        data: dataResult.rows,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum)
        }
      });
    }

    // No pagination – return all
    const result = await pool.query(
      `SELECT * FROM services WHERE ${whereClause} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// Batch delete services
router.post('/batch-delete', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid IDs array is required' });
    }

    await pool.query(
      'DELETE FROM services WHERE id = ANY($1::int[]) AND user_id = $2',
      [ids, req.userId]
    );

    res.json({ message: `${ids.length} services deleted successfully` });
  } catch (error) {
    console.error('Error batch deleting services:', error);
    res.status(500).json({ error: 'Failed to batch delete services' });
  }
});

// Create service
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, description, price, tax_rate, status = 'active' } = req.body;

    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const priceValue = parseFloat(price);
    if (isNaN(priceValue) || priceValue <= 0) {
      return res.status(400).json({ error: 'Invalid price value' });
    }

    const result = await pool.query(
      'INSERT INTO services (user_id, name, description, price, tax_rate, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.userId, name, description, priceValue, tax_rate || 0, status]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating service:', error);
    res.status(500).json({
      error: 'Failed to create service',
      details: error.message
    });
  }
});

// Get service by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM services WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

// Update service
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, description, price, tax_rate, status } = req.body;

    const result = await pool.query(
      `UPDATE services SET 
        name = COALESCE($1, name), 
        description = COALESCE($2, description), 
        price = COALESCE($3, price), 
        tax_rate = COALESCE($4, tax_rate), 
        status = COALESCE($5, status),
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = $6 AND user_id = $7 RETURNING *`,
      [name, description, price, tax_rate, status, req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

// Delete service
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM services WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

export default router;
