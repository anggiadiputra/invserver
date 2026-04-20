import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { WalletService } from '../services/wallet.js';
import pool from '../db/pool.js';

const router = express.Router();

// Get wallet balance and transaction history
router.get('/', authMiddleware, async (req, res) => {
  try {
    const data = await WalletService.getWalletData(req.userId);
    res.json(data);
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    res.status(500).json({ error: 'Failed to fetch wallet data' });
  }
});

// Initiate Top-up (Generate Pakasir Payment Link)
router.post('/topup', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.userId;

    if (!amount || amount < 10000) {
      return res.status(400).json({ error: 'Minimum top-up is Rp 10.000' });
    }

    // 1. Get Pakasir settings from database
    const settingsResult = await pool.query(
      'SELECT pakasir_slug, pakasir_api_key, pakasir_is_sandbox FROM system_settings LIMIT 1'
    );
    const settings = settingsResult.rows[0];

    if (!settings || !settings.pakasir_slug || !settings.pakasir_api_key) {
      return res.status(500).json({ 
        error: 'System is not configured for payments. Please contact admin.' 
      });
    }

    // 2. Format order ID: TOPUP-{userId}-{timestamp}
    // This format is used by our webhook to identify the user
    const orderId = `TOPUP-${userId}-${Date.now()}`;

    // 3. Generate Redirect Link (Model A: Simple redirect as per pakasir.md)
    // We use the redirect model because it's easier and requires no extra SDK calls 
    // for just generating a link.
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/wallet?status=success`;
    
    // Model A URL: https://app.pakasir.com/pay/{slug}/{amount}?order_id={orderId}&redirect={redirectUrl}
    const paymentUrl = `https://app.pakasir.com/pay/${settings.pakasir_slug}/${amount}?order_id=${orderId}&redirect=${encodeURIComponent(redirectUrl)}`;

    res.json({
      order_id: orderId,
      amount,
      payment_url: paymentUrl
    });
  } catch (error) {
    console.error('Error creating top-up:', error);
    res.status(500).json({ error: 'Failed to initiate top-up' });
  }
});

export default router;
