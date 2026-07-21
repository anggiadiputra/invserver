import express from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.js';
import pool from '../db/pool.js';
import { generateSystemInvoice } from '../utils/systemInvoices.js';

const router = express.Router();

/**
 * Get Sumopod config from system_settings
 */
async function getSumopodConfig() {
  const settingsResult = await pool.query(
    'SELECT sumopod_api_key, sumopod_is_sandbox FROM system_settings LIMIT 1'
  );
  const settings = settingsResult.rows[0];

  if (!settings || !settings.sumopod_api_key) {
    throw new Error('System is not configured for payments. Please contact admin.');
  }

  const isSandbox = settings.sumopod_is_sandbox !== false; // default true (sandbox)
  const baseUrl = isSandbox
    ? 'https://api-pay-sandbox.sumopod.com'
    : 'https://api-pay.sumopod.com';

  return { apiKey: settings.sumopod_api_key, baseUrl, isSandbox };
}

function parseAmount(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Get wallet balance and transaction history (User)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 100); // Max 100
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    const data = await WalletService.getWalletData(req.userId, page, limit, search);
    res.json(data);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// Admin: Get all transactions
router.get('/all-transactions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let queryParams = [];
    let whereClause = '';

    if (search) {
      whereClause = `
        WHERE u.email ILIKE $1 
           OR u.first_name ILIKE $1 
           OR u.last_name ILIKE $1 
           OR wt.description ILIKE $1 
           OR wt.payment_order_id ILIKE $1
           OR i.invoice_number ILIKE $1
           OR si.invoice_number ILIKE $1
      `;
      queryParams.push(`%${search}%`);
    }

    queryParams.push(limit, offset);

    const history = await pool.query(`
      SELECT wt.*, u.email, u.first_name, u.last_name,
             COALESCE(i.invoice_number, si.invoice_number) as invoice_number
      FROM wallet_transactions wt 
      JOIN users u ON wt.user_id = u.id 
      LEFT JOIN invoices i ON wt.invoice_id = i.id
      LEFT JOIN system_invoices si ON wt.system_invoice_id = si.id
      ${whereClause}
      ORDER BY wt.created_at DESC 
      LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}
    `, queryParams);

    const countRes = await pool.query(`
      SELECT COUNT(*) 
      FROM wallet_transactions wt 
      JOIN users u ON wt.user_id = u.id 
      LEFT JOIN invoices i ON wt.invoice_id = i.id
      LEFT JOIN system_invoices si ON wt.system_invoice_id = si.id
      ${whereClause}
    `, search ? [`%${search}%`] : []);

    res.json({
      transactions: history.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      limit
    });
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
      return res
        .status(400)
        .json({
          error: 'Invalid parameters for manual adjustment (Target user and amount required)',
        });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    let newBalance;
    if (type === 'deposit') {
      newBalance = await WalletService.addBalance(
        userId,
        parsedAmount,
        `[Admin Adjust] ${description}`
      );
      // Generate system invoice for manual deposit
      generateSystemInvoice(
        userId,
        'topup',
        parsedAmount,
        `Top-up Saldo (Admin Adjust): ${description}`,
        `ADJ-${Date.now()}`
      ).catch(console.error);
    } else if (type === 'refund') {
      newBalance = await WalletService.addBalance(
        userId,
        parsedAmount,
        `[Admin Refund] ${description}`
      );
      // Generate system invoice for REFUND
      generateSystemInvoice(
        userId,
        'refund',
        parsedAmount,
        `Refund Saldo: ${description}`,
        `REF-${Date.now()}`
      ).catch(console.error);
    } else if (type === 'deduction') {
      const refId = `ADJ-${Date.now()}`;
      newBalance = await WalletService.deductBalance(
        userId,
        parsedAmount,
        `[Admin Adjust] ${description}`,
        refId
      );
    } else {
      return res.status(400).json({ error: 'Invalid adjustment type' });
    }

    res.json({ success: true, newBalance });
  } catch (error) {
    console.error('Error in manual adjustment:', error);
    if (error.message === 'INSUFFICIENT_BALANCE') {
      return res
        .status(400)
        .json({ error: 'Saldo pengguna tidak mencukupi untuk pemotongan (Deduction) ini.' });
    }
    res.status(500).json({ error: 'Failed to manually adjust balance' });
  }
});

// Initiate Top-up with Sumopod API
router.post('/topup', authMiddleware, async (req, res) => {
  try {
    const { amount, method } = req.body;
    const userId = req.userId;

    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null || parsedAmount < 10000) {
      return res.status(400).json({ error: 'Minimum top-up is Rp 10.000 and amount must be a number' });
    }

    if (!method) {
      return res.status(400).json({ error: 'Payment method is required' });
    }

    const orderId = `TOPUP-${userId}-${Date.now()}`;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    try {
      const { apiKey, baseUrl } = await getSumopodConfig();

      const response = await fetch(`${baseUrl}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({
          order_id: orderId,
          amount: parsedAmount,
          currency: 'IDR',
          expires_in_hours: 24,
          success_return_url: `${frontendUrl}/billing?paid=1`,
          cancel_return_url: `${frontendUrl}/billing?cancelled=1`,
          payment_method_type_code: method,
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error('[Sumopod Create Error]:', response.status, errBody);
        return res.status(502).json({
          error: `Payment gateway error (${response.status}). Please try again later.`,
        });
      }

      const result = await response.json();
      console.log('[Sumopod Create Response]:', JSON.stringify(result, null, 2));

      // Fee is returned by Sumopod, no need for manual calculation
      const feeAmount = typeof result.fee === 'number' ? result.fee : Number(result.fee ?? 0);
      const totalAmount = parsedAmount + feeAmount;

      // Log as pending transaction so user can resume later
      await WalletService.createPendingDeposit(
        userId,
        parsedAmount,
        `Top-up saldo (Order: ${orderId})`,
        orderId,                           // → payment_order_id
        result.payment_link_url || null,   // → payment_url
        method,                            // → payment_method
        null,                              // → payment_number (Sumopod doesn't return this)
        result.expires_at || null,
        feeAmount
      );

      res.json({
        payment_id: result.payment_id,
        order_id: orderId,
        amount: totalAmount,
        nominal: parsedAmount,
        fee_amount: feeAmount,
        payment_link_url: result.payment_link_url,
        payment_method: method,
        status: result.status || 'pending',
        expires_at: result.expires_at || null,
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[Topup Error Detail]:', e);
      return res.status(500).json({
        error: `Gagal inisialisasi: ${e.message}`,
        detail: e.stack,
      });
    }
  } catch (error) {
    console.error('Error in route handler:', error);
    res.status(500).json({ error: `Terjadi kesalahan sistem: ${error.message}` });
  }
});

// Check Top-up Status
// Note: Sumopod does not document a GET /payments/{id} endpoint.
// We check our own DB. Once the webhook fires, the status will be 'completed'.
router.post('/topup/check-status', authMiddleware, async (req, res) => {
  try {
    const { order_id } = req.body;
    const userId = req.userId;

    if (!order_id) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    // Security check: Make sure order_id belongs to the requester
    if (!order_id.startsWith(`TOPUP-${userId}-`)) {
      return res.status(403).json({ error: 'Unauthorized to check this order status' });
    }

    // Look up the transaction in our DB
    const txResult = await pool.query(
      'SELECT status, amount FROM wallet_transactions WHERE user_id = $1 AND payment_order_id = $2',
      [userId, order_id]
    );

    if (txResult.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const tx = txResult.rows[0];

    if (tx.status === 'completed') {
      // Generate system invoice if not already generated
      generateSystemInvoice(
        userId,
        'topup',
        parseFloat(tx.amount),
        `Top-up Saldo (Order: ${order_id})`,
        order_id
      ).catch(console.error);
    }

    res.json({ status: tx.status });
  } catch (error) {
    console.error('Error checking top-up status:', error);
    res.status(500).json({ error: 'Failed to check top-up status' });
  }
});

// Cancel a pending top-up (Admin or Owner)
router.post('/topup/cancel', authMiddleware, async (req, res) => {
  try {
    const { order_id } = req.body;
    const userId = req.userId;

    if (!order_id) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    // Check if user is admin
    const userRoleRes = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isAdmin = userRoleRes.rows[0]?.role === 'admin';

    // Security check: Only admin or the owner can cancel
    if (!isAdmin && !order_id.startsWith(`TOPUP-${userId}-`)) {
      return res.status(403).json({ error: 'Unauthorized to cancel this order' });
    }

    const success = await WalletService.failDeposit(order_id);
    if (success) {
      res.json({ message: 'Transaksi berhasil dibatalkan' });
    } else {
      res.status(400).json({ error: 'Gagal membatalkan transaksi atau transaksi sudah diproses' });
    }
  } catch (error) {
    console.error('Error canceling top-up:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Webhook Sumopod: Automatic Top-up confirmation
 * Verifies using X-Webhook-Token header (simpler alternative to Svix signature)
 */
router.post('/webhook/sumopod', async (req, res) => {
  try {
    // 1. Verify X-Webhook-Token
    const settingsResult = await pool.query(
      'SELECT sumopod_webhook_token FROM system_settings LIMIT 1'
    );
    const expectedToken = settingsResult.rows[0]?.sumopod_webhook_token;
    const receivedToken = req.headers['x-webhook-token'];

    if (!expectedToken || expectedToken !== receivedToken) {
      console.warn('[Webhook] Invalid or missing webhook token');
      return res.status(401).json({ error: 'Invalid webhook token' });
    }

    // 2. Parse Sumopod event
    const { event_type, data } = req.body;

    console.log(`[Webhook] Received Sumopod event: ${event_type} for order ${data?.order_id}`);

    // Only process completed payments
    if (event_type !== 'payment.completed') {
      return res.json({ message: `Event ${event_type} ignored` });
    }

    if (!data || !data.order_id) {
      return res.status(400).json({ error: 'Invalid webhook payload: missing order_id' });
    }

    // 3. Resolve userId from order_id (Format: TOPUP-{userId}-{timestamp})
    if (!data.order_id.startsWith('TOPUP-')) {
      return res.status(400).json({ error: 'Invalid order format' });
    }

    const parts = data.order_id.split('-');
    if (parts.length < 3) {
      return res.status(400).json({ error: 'Invalid order format' });
    }

    const userId = parseInt(parts[1]);

    if (!userId || isNaN(userId)) {
      return res.status(400).json({ error: 'Could not resolve user from order' });
    }

    // 4. Complete the transaction (idempotent — completeDeposit checks FOR UPDATE)
    const amount = parseAmount(data.amount) || parseAmount(data.net_amount);
    if (amount === null) {
      return res.status(400).json({ error: 'Invalid amount in webhook payload' });
    }

    const completedBalance = await WalletService.completeDeposit(userId, data.order_id);

    if (completedBalance !== false) {
      console.log(`[Webhook] Auto-completed balance for user ${userId}: Rp ${amount}`);

      // Generate system invoice
      generateSystemInvoice(
        userId,
        'topup',
        amount,
        `Top-up Saldo Otomatis (Order: ${data.order_id})`,
        data.order_id
      ).catch((err) => {
        console.error('[Webhook] Failed to generate system invoice:', err);
      });
    } else {
      console.log(`[Webhook] Transaction ${data.order_id} already completed or not found`);
    }

    res.json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('[Webhook Error]:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
