import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.js';
import { generateSystemInvoice } from '../utils/systemInvoices.js';

const router = express.Router();

/**
 * GET /api/plans
 * Returns all available subscription plans
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM plans ORDER BY price_monthly ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching plans:', error);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

/**
 * ADMIN: Create new plan
 */
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { slug, name, description, price_monthly, max_invoices, max_customers, features } =
      req.body;

    if (!slug || !name || price_monthly === undefined) {
      return res.status(400).json({ error: 'Slug, name, and price_monthly are required' });
    }

    // Ensure numeric fields are valid or fallback to default
    const parsedPrice = parseFloat(price_monthly) || 0;
    const parsedMaxInvoices = parseInt(max_invoices) || 0;
    const parsedMaxCustomers = parseInt(max_customers) || 0;

    const result = await pool.query(
      `
      INSERT INTO plans (slug, name, description, price_monthly, max_invoices, max_customers, features)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
      [
        slug,
        name,
        description || '',
        parsedPrice,
        parsedMaxInvoices,
        parsedMaxCustomers,
        features || {},
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating plan:', error);
    if (error.code === '23505') {
      // Unique violation
      return res.status(400).json({ error: 'Slug must be unique' });
    }
    res.status(500).json({ error: error.message || 'Failed to create plan' });
  }
});

/**
 * ADMIN: Update plan
 */
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { slug, name, description, price_monthly, max_invoices, max_customers, features } =
      req.body;

    if (!slug || !name || price_monthly === undefined) {
      return res.status(400).json({ error: 'Slug, name, and price_monthly are required' });
    }

    // Ensure numeric fields are valid or fallback to default
    const parsedPrice = parseFloat(price_monthly) || 0;
    const parsedMaxInvoices = parseInt(max_invoices) || 0;
    const parsedMaxCustomers = parseInt(max_customers) || 0;

    const result = await pool.query(
      `
      UPDATE plans 
      SET slug = $1, name = $2, description = $3, price_monthly = $4, 
          max_invoices = $5, max_customers = $6, features = $7,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `,
      [
        slug,
        name,
        description || '',
        parsedPrice,
        parsedMaxInvoices,
        parsedMaxCustomers,
        features || {},
        parseInt(id),
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating plan:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Slug must be unique' });
    }
    res.status(500).json({ error: error.message || 'Failed to update plan' });
  }
});

/**
 * ADMIN: Delete plan
 */
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if it's the default 'free' plan
    const planResult = await pool.query('SELECT slug FROM plans WHERE id = $1', [id]);
    if (planResult.rows.length > 0 && planResult.rows[0].slug === 'free') {
      return res.status(400).json({ error: 'Cannot delete the Free plan' });
    }

    // Attempt to delete (will fail if there are active subscriptions due to foreign keys, unless cascaded)
    await pool.query('DELETE FROM plans WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting plan:', error);
    // 23503 is foreign_key_violation
    if (error.code === '23503') {
      return res
        .status(400)
        .json({ error: 'Cannot delete plan because there are users subscribed to it' });
    }
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

/**
 * POST /api/plans/upgrade
 * Manually upgrade to a new plan or renew current plan
 */
router.post('/upgrade', authMiddleware, async (req, res) => {
  const { planId } = req.body;
  const userId = req.userId;

  if (!planId) {
    return res.status(400).json({ error: 'Plan ID is required' });
  }

  // Use shared transaction to ensure atomicity of deduction + subscription update
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get Plan details (locked to prevent race)
    const planResult = await client.query('SELECT * FROM plans WHERE id = $1 FOR UPDATE', [planId]);
    if (planResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Plan not found' });
    }
    const targetPlan = planResult.rows[0];

    // 2. Check current subscription (locked)
    const subResult = await client.query(
      'SELECT s.*, p.slug as current_plan_slug FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.user_id = $1 FOR UPDATE',
      [userId]
    );
    const currentSub = subResult.rows[0];

    // 3. Prevent duplicate transactions (Idempotency check)
    const recentTx = await client.query(
      `SELECT id FROM wallet_transactions 
       WHERE user_id = $1 
       AND type = 'deduction' 
       AND status = 'completed' 
       AND description LIKE $2
       AND created_at > NOW() - INTERVAL '5 minutes'`,
      [userId, `%${targetPlan.name}%`]
    );

    if (recentTx.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(429).json({ 
        error: 'Transaksi paket ini baru saja berhasil dilakukan. Jika saldo Anda terpotong namun paket belum berubah, silakan tunggu 1-2 menit atau hubungi bantuan.' 
      });
    }

    // 4. Check wallet balance and deduct (atomically within shared transaction)
    const walletResult = await client.query(
      'SELECT balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const wallet = walletResult.rows[0];
    if (!wallet || parseFloat(wallet.balance) < targetPlan.price_monthly) {
      await client.query('ROLLBACK');
      return res.status(402).json({ error: 'Saldo tidak cukup untuk upgrade Paket' });
    }

    const newBalance = parseFloat(wallet.balance) - targetPlan.price_monthly;
    const subRefId = `SUB-${userId}-${Date.now()}`;

    await client.query(
      `UPDATE user_wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
      [newBalance, userId]
    );

    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, payment_order_id, status)
       VALUES ($1, 'deduction', $2, $3, $4, $5, 'completed')`,
      [userId, targetPlan.price_monthly, newBalance, `Upgrade/Pembaruan paket ke ${targetPlan.name}`, subRefId]
    );

    // 5. Update Subscription
    let newExpiry = new Date();
    if (currentSub && currentSub.expires_at && new Date(currentSub.expires_at) > new Date()) {
      newExpiry = new Date(currentSub.expires_at);
    }
    newExpiry.setDate(newExpiry.getDate() + 30);

    const updatedSub = await client.query(
      `UPDATE subscriptions 
       SET plan_id = $1, status = 'active', expires_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $3
       RETURNING *`,
      [targetPlan.id, newExpiry, userId]
    );

    await client.query('COMMIT');
    client.release();

    const subscription = updatedSub.rows[0];

    // Generate system invoice (non-critical, fire-and-forget)
    generateSystemInvoice(
      userId,
      'subscription',
      targetPlan.price_monthly,
      `Pembayaran Paket: ${targetPlan.name}`,
      subRefId
    ).catch(console.error);

    res.json({
      message: `Successfully upgraded to ${targetPlan.name}`,
      subscription,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('Upgrade error:', error);
    res.status(500).json({ error: 'Gagal melakukan upgrade langganan' });
  }
});

export default router;
