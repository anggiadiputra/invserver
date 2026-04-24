import express from 'express';
import { WalletService } from '../services/wallet.js';
import pool from '../db/pool.js';

const router = express.Router();

// Pakasir Webhook Handler
router.post('/pakasir', async (req, res) => {
  const { order_id, amount, status, project } = req.body;

  console.log(
    `[Webhook] Received Pakasir event: Order=${order_id}, Status=${status}, Amount=${amount}`
  );

  try {
    // 1. Basic Validation
    if (status !== 'completed') {
      return res.json({ ok: true, message: 'Status not completed, skipping.' });
    }

    if (!order_id) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    // 2. Identify transaction type by order_id prefix
    if (order_id.startsWith('TOPUP-')) {
      // Format: TOPUP-{userId}-{timestamp}
      const parts = order_id.split('-');
      if (parts.length < 2) throw new Error('Invalid TOPUP order_id format');

      const userId = parseInt(parts[1]);
      const depositAmount = parseFloat(amount);

      // 3. Add balance to wallet
      await WalletService.addBalance(
        userId,
        depositAmount,
        `Top-up saldo via Pakasir (Order: ${order_id})`,
        order_id
      );

      // 4. (Optional) Resume grace period subscription if balance is now enough
      // This will be handled by the daily cron, but we could trigger it here too.
      // For now, let's keep it simple and wait for cron.
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[Webhook] Error processing Pakasir webhook:', error);
    // Pakasir will retry if we return a non-200 status.
    // However, if it's a code error, retrying might not help.
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
