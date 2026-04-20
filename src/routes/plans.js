import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.js';

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
 * POST /api/subscriptions/upgrade
 * Manually upgrade to a new plan or renew current plan
 */
router.post('/upgrade', authMiddleware, async (req, res) => {
  const { planId } = req.body;
  const userId = req.userId;

  if (!planId) {
    return res.status(400).json({ error: 'Plan ID is required' });
  }

  try {
    // 1. Get Plan details
    const planResult = await pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
    if (planResult.rows.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    const targetPlan = planResult.rows[0];

    // 2. Check current subscription
    const subResult = await pool.query(
      'SELECT s.*, p.slug as current_plan_slug FROM subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.user_id = $1',
      [userId]
    );
    const currentSub = subResult.rows[0];

    // 3. Deduct balance via WalletService
    // description: Upgrade ke [Plan Name]
    await WalletService.deductBalance(
      userId, 
      targetPlan.price_monthly, 
      `Upgrade/Pembaruan paket ke ${targetPlan.name}`
    );

    // 4. Update Subscription
    // Logic Model A: Access until end of period. 
    // If upgrading from Free, we start 30 days from now.
    // If renewing same plan, we add 30 days to current expiry if it's in the future.
    
    let newExpiry = new Date();
    if (currentSub && currentSub.expires_at && new Date(currentSub.expires_at) > new Date()) {
      newExpiry = new Date(currentSub.expires_at);
    }
    newExpiry.setDate(newExpiry.getDate() + 30);

    const updatedSub = await pool.query(`
      UPDATE subscriptions 
      SET 
        plan_id = $1, 
        status = 'active', 
        expires_at = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $3
      RETURNING *
    `, [targetPlan.id, newExpiry, userId]);

    res.json({
      message: `Successfully upgraded to ${targetPlan.name}`,
      subscription: updatedSub.rows[0]
    });

  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: 'Saldo tidak cukup untuk upgrade paket' });
    }
    console.error('Upgrade error:', error);
    res.status(500).json({ error: 'Gagal melakukan upgrade langganan' });
  }
});

export default router;
