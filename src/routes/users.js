import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// GET all users (Admin Only) with status filtering, search, and pagination
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, search, page, limit } = req.query;

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }

    if (search) {
      conditions.push(
        `(email ILIKE $${paramIdx} OR first_name ILIKE $${paramIdx} OR last_name ILIKE $${paramIdx} OR company_name ILIKE $${paramIdx})`
      );
      params.push(`%${search}%`);
      paramIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (page && limit) {
      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const offset = (pageNum - 1) * limitNum;

      const [dataResult, countResult] = await Promise.all([
        pool.query(
          `
          SELECT id, email, first_name, last_name, company_name, role, status, created_at 
          FROM users 
          ${whereClause} 
          ORDER BY created_at DESC 
          LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `,
          [...params, limitNum, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM users ${whereClause}`, params),
      ]);

      const total = parseInt(countResult.rows[0].count);
      return res.json({
        users: dataResult.rows,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      });
    }

    const result = await pool.query(
      `
      SELECT 
        id, email, first_name, last_name, company_name, role, status, created_at 
      FROM users 
      ${whereClause}
      ORDER BY created_at DESC
    `,
      params
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user (Admin Only)
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { first_name, last_name, company_name, role, status } = req.body;

    const result = await pool.query(
      `
      UPDATE users 
      SET first_name = COALESCE($1, first_name),
          last_name = COALESCE($2, last_name),
          company_name = COALESCE($3, company_name),
          role = COALESCE($4, role),
          status = COALESCE($5, status),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING id, email, first_name, last_name, company_name, role, status, created_at
    `,
      [first_name, last_name, company_name, role, status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Batch delete users (Admin Only)
router.post('/batch-delete', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid IDs array is required' });
    }

    // Prevent deleting self
    const targetIds = ids.filter((id) => parseInt(id) !== req.userId);
    if (targetIds.length === 0) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [targetIds]);

    res.json({ message: `${targetIds.length} users deleted successfully` });
  } catch (error) {
    console.error('Error batch deleting users:', error);
    res.status(500).json({ error: 'Failed to batch delete users' });
  }
});

// Delete single user (Admin Only)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.userId) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
