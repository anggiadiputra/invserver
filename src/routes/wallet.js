import express from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.js';
import pool from '../db/pool.js';
import { Pakasir } from 'pakasir-sdk';
import { generateSystemInvoice } from '../utils/systemInvoices.js';

const router = express.Router();

/**
 * Get internal Pakasir instance
 */
async function getPakasirInstance() {
  const settingsResult = await pool.query(
    'SELECT pakasir_slug, pakasir_api_key, pakasir_is_sandbox FROM system_settings LIMIT 1'
  );
  const settings = settingsResult.rows[0];

  if (!settings || !settings.pakasir_slug || !settings.pakasir_api_key) {
    throw new Error('System is not configured for payments. Please contact admin.');
  }

  return new Pakasir({
    slug: settings.pakasir_slug,
    apikey: settings.pakasir_api_key,
  });
}

// Get wallet balance and transaction history (User)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await WalletService.getWalletData(req.userId);
    res.json(data);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// Admin: Get all transactions
router.get('/all-transactions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const history = await pool.query(`
      SELECT wt.*, u.email, u.first_name, u.last_name 
      FROM wallet_transactions wt 
      JOIN users u ON wt.user_id = u.id 
      ORDER BY wt.created_at DESC 
      LIMIT 200
    `);
    res.json(history.rows);
  } catch (error) {
    console.error('Error fetching all transactions:', error);
    res.status(500).json({ error: 'Failed to fetch overall transaction history' });
  }
});

// Admin: Manual wallet adjustment
router.post('/manual-adjust', authMiddleware, adminOnly, async (req, res) => {
  try {
    let { userId, email, amount, type, description } = req.body;
    
    // Resolve userId from email if needed
    if (!userId && email) {
      const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'User with this email not found' });
      }
      userId = userRes.rows[0].id;
    }

    if (!userId || !amount || parseFloat(amount) <= 0 || !description) {
      return res.status(400).json({ error: 'Invalid parameters for manual adjustment (Target user and amount required)' });
    }

    let newBalance;
    if (type === 'deposit') {
      newBalance = await WalletService.addBalance(userId, parseFloat(amount), `[Admin Adjust] ${description}`);
      // Generate system invoice for manual deposit
      generateSystemInvoice(userId, 'topup', parseFloat(amount), `Top-up Saldo (Admin Adjust): ${description}`, `ADJ-${Date.now()}`).catch(console.error);
    } else if (type === 'deduction') {
      const refId = `ADJ-${Date.now()}`;
      newBalance = await WalletService.deductBalance(userId, parseFloat(amount), `[Admin Adjust] ${description}`, refId);
    } else {
      return res.status(400).json({ error: 'Invalid adjustment type' });
    }

    res.json({ success: true, newBalance });
  } catch (error) {
    console.error('Error in manual adjustment:', error);
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Saldo pengguna tidak mencukupi untuk pemotongan (Deduction) ini.' });
    }
    res.status(500).json({ error: 'Failed to manually adjust balance' });
  }
});

// Initiate Top-up with Pakasir SDK (Direct API)
router.post('/topup', authMiddleware, async (req, res) => {
  try {
    const { amount, method } = req.body;
    const userId = req.userId;

    if (!amount || amount < 10000) {
      return res.status(400).json({ error: 'Minimum top-up is Rp 10.000' });
    }
    
    if (!method) {
      return res.status(400).json({ error: 'Payment method is required' });
    }

    const orderId = `TOPUP-${userId}-${Date.now()}`;

    try {
      const pakasir = await getPakasirInstance();
      const result = await pakasir.createPayment(method, orderId, amount);
      
      res.json(result);
    } catch (e) {
      if (e.message && e.message.includes('configured')) {
        return res.status(500).json({ error: e.message });
      }
      throw e;
    }
  } catch (error) {
    console.error('Error creating top-up:', error);
    res.status(500).json({ error: 'Failed to initiate top-up. Tolong hubungi admin.' });
  }
});

// Check Top-up Status and add balance if successful
router.post('/topup/check-status', authMiddleware, async (req, res) => {
  try {
    const { order_id, amount } = req.body;
    const userId = req.userId;

    if (!order_id || !amount) {
      return res.status(400).json({ error: 'Order ID and amount are required' });
    }

    // Security check: Make sure order_id belongs to the requester
    if (!order_id.startsWith(`TOPUP-${userId}-`)) {
      return res.status(403).json({ error: 'Unauthorized to check this order status' });
    }

    const pakasir = await getPakasirInstance();
    const detail = await pakasir.detailPayment(order_id, parseFloat(amount));

    if (!detail) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Note: Detail returns an object like { status: 'completed' | 'pending' | 'canceled' }
    if (detail.status === 'completed') {
      // Check if we already added the balance (due to async webhook execution)
      const existingTx = await pool.query(
        'SELECT id FROM wallet_transactions WHERE pakasir_order_id = $1 LIMIT 1',
        [order_id]
      );

      if (existingTx.rows.length === 0) {
        // Safe to add balance
        await WalletService.addBalance(
          userId, 
          parseFloat(amount), 
          `Top-up saldo (Order: ${order_id})`,
          order_id
        );
        // Generate system invoice for completed top-up
        generateSystemInvoice(userId, 'topup', parseFloat(amount), `Top-up Saldo (Order: ${order_id})`, order_id).catch(console.error);
      }
    }

    res.json({ status: detail.status });
  } catch (error) {
    console.error('Error checking top-up status:', error);
    res.status(500).json({ error: 'Failed to check top-up status' });
  }
});

/**
 * Webhook Pakasir: Automatic Top-up confirmation
 * Note: This endpoint does NOT use authMiddleware as it's called by Pakasir server
 */
router.post('/webhook/pakasir', async (req, res) => {
  try {
    const { order_id, amount, status } = req.body;

    console.log(`[Webhook] Received Pakasir update for ${order_id}: ${status}`);

    if (status !== 'completed') {
      return res.json({ message: 'Status ignored' });
    }

    // 1. Resolve userId from order_id (Format: TOPUP-userId-timestamp)
    if (!order_id || !order_id.startsWith('TOPUP-')) {
      return res.status(400).json({ error: 'Invalid order format' });
    }
    
    const parts = order_id.split('-');
    const userId = parseInt(parts[1]);

    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: 'Could not resolve user from order' });
    }

    // 2. Security: Always verify with Pakasir detail API to prevent fake webhooks
    const pakasir = await getPakasirInstance();
    const detail = await pakasir.detailPayment(order_id, parseFloat(amount));

    if (!detail || detail.status !== 'completed') {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // 3. Idempotency check: Don't process twice
    const existingTx = await pool.query(
      'SELECT id FROM wallet_transactions WHERE pakasir_order_id = $1 LIMIT 1',
      [order_id]
    );

    if (existingTx.rows.length === 0) {
      console.log(`[Webhook] Auto-adding balance for user ${userId}: Rp ${amount}`);
      
      await WalletService.addBalance(
        userId, 
        parseFloat(amount), 
        `Top-up saldo otomatis (Order: ${order_id})`,
        order_id
      );

      // Generate system invoice
      generateSystemInvoice(userId, 'topup', parseFloat(amount), `Top-up Saldo Otomatis (Order: ${order_id})`, order_id).catch(err => {
        console.error('[Webhook] Failed to generate system invoice:', err);
      });
    }

    res.json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('[Webhook Error]:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
