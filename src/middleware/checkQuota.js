import pool from '../db/pool.js';

/**
 * Middleware to check if user has reached their invoice quota
 */
export async function checkInvoiceQuota(req, res, next) {
  try {
    const userId = req.userId;

    // Get active subscription and its plan limits
    const result = await pool.query(
      `
      SELECT p.max_invoices, s.status as sub_status, s.is_lifetime
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = $1
    `,
      [userId]
    );

    if (result.rows.length === 0) {
      // This shouldn't happen with the backfill migration, but just in case
      return res
        .status(403)
        .json({ error: 'No active subscription found. Please contact support.' });
    }

    const { max_invoices, sub_status, is_lifetime } = result.rows[0];

    // 0. Lifetime users have no restrictions
    if (is_lifetime === true) {
      return next();
    }

    // 1. Check if subscription is in good standing
    const allowedStatuses = ['active', 'trial', 'cancelled', 'grace_period', 'past_due', 'lifetime'];
    if (!allowedStatuses.includes(sub_status)) {
      return res.status(402).json({
        error: 'Your subscription is no longer active. Please upgrade or renew to continue.',
        code: 'SUBSCRIPTION_INACTIVE',
        upgrade_url: '/pricing',
      });
    }

    // 2. Check quota (if not unlimited)
    if (max_invoices !== -1) {
      const countResult = await pool.query(
        'SELECT COUNT(*) as count FROM invoices WHERE user_id = $1',
        [userId]
      );
      const currentCount = parseInt(countResult.rows[0].count);

      if (currentCount >= max_invoices) {
        return res.status(402).json({
          error: `Invoice limit reached (${currentCount}/${max_invoices}). Please upgrade your plan to create more.`,
          code: 'QUOTA_EXCEEDED',
          upgrade_url: '/pricing',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Invoice Quota Check Error:', error);
    res.status(500).json({ error: 'Internal server error during quota verification.' });
  }
}

/**
 * Middleware to check if user has reached their customer quota
 */
export async function checkCustomerQuota(req, res, next) {
  try {
    const userId = req.userId;

    const result = await pool.query(
      `
      SELECT p.max_customers, s.status as sub_status, s.is_lifetime
      FROM subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = $1
    `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res
        .status(403)
        .json({ error: 'No active subscription found. Please contact support.' });
    }

    const { max_customers, sub_status, is_lifetime } = result.rows[0];

    // 0. Lifetime users have no restrictions
    if (is_lifetime === true) {
      return next();
    }

    const allowedStatuses = ['active', 'trial', 'cancelled', 'grace_period', 'past_due', 'lifetime'];
    if (!allowedStatuses.includes(sub_status)) {
      return res.status(402).json({
        error: 'Your subscription is no longer active. Please upgrade or renew to continue.',
        code: 'SUBSCRIPTION_INACTIVE',
        upgrade_url: '/pricing',
      });
    }

    if (max_customers !== -1) {
      const countResult = await pool.query(
        'SELECT COUNT(*) as count FROM customers WHERE user_id = $1',
        [userId]
      );
      const currentCount = parseInt(countResult.rows[0].count);

      if (currentCount >= max_customers) {
        return res.status(402).json({
          error: `Customer limit reached (${currentCount}/${max_customers}). Please upgrade your plan to create more.`,
          code: 'QUOTA_EXCEEDED',
          upgrade_url: '/pricing',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Customer Quota Check Error:', error);
    res.status(500).json({ error: 'Internal server error during quota verification.' });
  }
}
