import cron from 'node-cron';
import pool from '../db/pool.js';
import { WalletService } from '../services/wallet.js';
import emailService from '../services/email.js';

/**
 * Daily Billing Job
 * Runs every day at 00:01 AM
 */
export const initBillingJob = () => {
  // '1 0 * * *' = Minute 1, Hour 0, every day
  cron.schedule('1 0 * * *', async () => {
    console.log('[BillingJob] Starting daily subscription check...');
    await processSubscriptions();
    console.log('[BillingJob] Daily check completed.');
  });
};

async function processSubscriptions() {
  const client = await pool.connect();
  try {
    // 1. Get all paid subscriptions that have expired or are due today
    // We exclude 'free' plan and 'inactive' status
    const dueSubscriptions = await client.query(`
      SELECT 
        s.id as subscription_id, 
        s.user_id, 
        s.expires_at, 
        s.status,
        p.id as plan_id,
        p.name as plan_name,
        p.price_monthly,
        u.email,
        u.first_name
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      JOIN users u ON s.user_id = u.id
      WHERE p.slug != 'free' 
        AND s.status IN ('active', 'grace_period')
        AND (s.expires_at <= CURRENT_DATE OR s.expires_at IS NULL)
    `);

    console.log(`[BillingJob] Found ${dueSubscriptions.rows.length} subscriptions to process.`);

    for (const sub of dueSubscriptions.rows) {
      try {
        await handleSubscriptionRenewal(sub);
      } catch (err) {
        console.error(`[BillingJob] Error processing subscription ${sub.subscription_id}:`, err);
      }
    }
  } catch (error) {
    console.error('[BillingJob] Critical error in processSubscriptions:', error);
  } finally {
    client.release();
  }
}

async function handleSubscriptionRenewal(sub) {
  const { user_id, price_monthly, plan_name, subscription_id, status, expires_at } = sub;

  try {
    // Attempt to deduct balance
    await WalletService.deductBalance(
      user_id,
      price_monthly,
      `Perpanjangan paket ${plan_name} (Auto-renewal)`
    );

    // If success, update subscription
    await pool.query(
      `
      UPDATE subscriptions 
      SET 
        status = 'active', 
        expires_at = COALESCE(expires_at, CURRENT_DATE) + INTERVAL '30 days',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
      [subscription_id]
    );

    console.log(`[BillingJob] Successfully renewed User ${user_id} for ${plan_name}`);

    // Send success email
    await sendNotification(sub, 'success');
  } catch (error) {
    if (error.message === 'INSUFFICIENT_BALANCE') {
      console.log(`[BillingJob] Insufficient balance for User ${user_id}. Handling failure...`);

      const gracePeriodDays = 7;
      const expiryDate = new Date(expires_at || new Date());
      const now = new Date();
      const diffDays = Math.ceil((now - expiryDate) / (1000 * 60 * 60 * 24));

      if (diffDays > gracePeriodDays) {
        // Downgrade to free
        console.log(`[BillingJob] Grace period exceeded for User ${user_id}. Downgrading to Free.`);

        const freePlan = await pool.query("SELECT id FROM plans WHERE slug = 'free'");
        const freePlanId = freePlan.rows[0].id;

        await pool.query(
          `
          UPDATE subscriptions 
          SET 
            plan_id = $1, 
            status = 'active', 
            expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP 
          WHERE id = $2
        `,
          [freePlanId, subscription_id]
        );

        await sendNotification(sub, 'downgrade');
      } else {
        // Set to grace period if not already
        if (status !== 'grace_period') {
          await pool.query(
            "UPDATE subscriptions SET status = 'grace_period', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [subscription_id]
          );
        }
        await sendNotification(sub, 'warning');
      }
    } else {
      throw error;
    }
  }
}

async function sendNotification(sub, type) {
  try {
    const settingsResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
    const settings = settingsResult.rows[0];

    if (!settings || !settings.smtp_host) return;

    let subject = '';
    let html = '';

    if (type === 'success') {
      subject = `Pembaruan Langganan ${sub.plan_name} Berhasil`;
      html = `<p>Halo ${sub.first_name},</p><p>Saldo Anda telah dipotong sebesar Rp ${sub.price_monthly} untuk perpanjangan paket <b>${sub.plan_name}</b> selama 30 hari ke depan. Terima kasih telah menggunakan Invoizes!</p>`;
    } else if (type === 'warning') {
      subject = `PENTING: Saldo Tidak Cukup untuk Langganan ${sub.plan_name}`;
      html = `<p>Halo ${sub.first_name},</p><p>Saldo Anda tidak cukup untuk memperpanjang paket <b>${sub.plan_name}</b>. Akun Anda telah memasuki masa tenggang (Grace Period) selama 7 hari. Mohon segera isi saldo agar fitur premium tetap aktif.</p>`;
    } else if (type === 'downgrade') {
      subject = `Langganan ${sub.plan_name} Berakhir`;
      html = `<p>Halo ${sub.first_name},</p><p>Masa tenggang langganan Anda telah berakhir. Akun Anda secara otomatis diturunkan ke paket <b>Gratis</b>. Data Anda tetap tersimpan, namun beberapa fitur premium mungkin tidak dapat diakses.</p>`;
    }

    await emailService.sendEmail(settings, {
      to: sub.email,
      subject,
      html,
    });
  } catch (err) {
    console.error('[BillingJob] Failed to send notification email:', err);
  }
}
