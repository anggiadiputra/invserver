import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get all customers (supports pagination via ?page=&limit= and full list without params)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page, limit, search } = req.query;

    // If page/limit provided, use pagination
    if (page && limit) {
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;
      const searchClause = search ? `AND (name ILIKE $3 OR email ILIKE $3 OR phone ILIKE $3)` : '';
      const params = search
        ? [req.userId, limitNum, `%${search}%`, offset]
        : [req.userId, limitNum, offset];
      const offsetParam = search ? '$4' : '$3';

      const [dataResult, countResult] = await Promise.all([
        pool.query(
          `SELECT * FROM customers WHERE user_id = $1 ${searchClause} ORDER BY created_at DESC LIMIT $2 OFFSET ${offsetParam}`,
          params
        ),
        pool.query(
          `SELECT COUNT(*) FROM customers WHERE user_id = $1 ${searchClause}`,
          search ? [req.userId, `%${search}%`] : [req.userId]
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

    // No pagination – return all (backwards compatible)
    const result = await pool.query(
      'SELECT * FROM customers WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Create customer
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { 
      name, email, phone, address, city, postal_code, country,
      province_id, regency_id, district_id, village_id,
      province_name, regency_name, district_name, village_name
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await pool.query(
      `INSERT INTO customers (
        user_id, name, email, phone, address, city, postal_code, country,
        province_id, regency_id, district_id, village_id,
        province_name, regency_name, district_name, village_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        req.userId, name, email, phone, address, city, postal_code, country,
        province_id, regency_id, district_id, village_id,
        province_name, regency_name, district_name, village_name
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// Get customer by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM customers WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// Update customer
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { 
      name, email, phone, address, city, postal_code, country,
      province_id, regency_id, district_id, village_id,
      province_name, regency_name, district_name, village_name
    } = req.body;

    const result = await pool.query(
      `UPDATE customers SET 
        name = $1, email = $2, phone = $3, address = $4, 
        city = $5, postal_code = $6, country = $7,
        province_id = $8, regency_id = $9, district_id = $10, village_id = $11,
        province_name = $12, regency_name = $13, district_name = $14, village_name = $15,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = $16 AND user_id = $17 RETURNING *`,
      [
        name, email, phone, address, city, postal_code, country,
        province_id, regency_id, district_id, village_id,
        province_name, regency_name, district_name, village_name,
        req.params.id, req.userId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// Delete customer
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM customers WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

export default router;
