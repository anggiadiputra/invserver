import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get all bank accounts for current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM bank_accounts WHERE user_id = $1 ORDER BY is_primary DESC, created_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ error: 'Failed to fetch bank accounts' });
  }
});

// Create bank account
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { bank_name, account_name, account_number, is_primary } = req.body;

    if (!bank_name || !account_name || !account_number) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If this is set as primary, unset all other primary accounts
      if (is_primary) {
        await client.query(
          'UPDATE bank_accounts SET is_primary = false WHERE user_id = $1',
          [req.userId]
        );
      }

      const result = await client.query(
        `INSERT INTO bank_accounts (user_id, bank_name, account_name, account_number, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.userId, bank_name, account_name, account_number, is_primary || false]
      );

      await client.query('COMMIT');
      res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating bank account:', error);
    res.status(500).json({ error: 'Failed to create bank account' });
  }
});

// Update bank account
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { bank_name, account_name, account_number, is_primary } = req.body;
    const accountId = req.params.id;

    // Verify ownership
    const existing = await pool.query(
      'SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2',
      [accountId, req.userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If this is set as primary, unset all other primary accounts
      if (is_primary) {
        await client.query(
          'UPDATE bank_accounts SET is_primary = false WHERE user_id = $1 AND id != $2',
          [req.userId, accountId]
        );
      }

      const result = await client.query(
        `UPDATE bank_accounts
         SET bank_name = $1, account_name = $2, account_number = $3, is_primary = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND user_id = $6
         RETURNING *`,
        [bank_name, account_name, account_number, is_primary || false, accountId, req.userId]
      );

      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating bank account:', error);
    res.status(500).json({ error: 'Failed to update bank account' });
  }
});

// Delete bank account
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const accountId = req.params.id;

    const result = await pool.query(
      'DELETE FROM bank_accounts WHERE id = $1 AND user_id = $2 RETURNING *',
      [accountId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    res.json({ message: 'Bank account deleted successfully' });
  } catch (error) {
    console.error('Error deleting bank account:', error);
    res.status(500).json({ error: 'Failed to delete bank account' });
  }
});

// Set primary bank account
router.patch('/:id/primary', authMiddleware, async (req, res) => {
  try {
    const accountId = req.params.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Unset all other primary accounts
      await client.query(
        'UPDATE bank_accounts SET is_primary = false WHERE user_id = $1',
        [req.userId]
      );

      // Set this one as primary
      const result = await client.query(
        'UPDATE bank_accounts SET is_primary = true WHERE id = $1 AND user_id = $2 RETURNING *',
        [accountId, req.userId]
      );

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Bank account not found' });
      }

      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error setting primary bank account:', error);
    res.status(500).json({ error: 'Failed to set primary bank account' });
  }
});

export default router;
