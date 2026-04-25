import pool from '../db/pool.js';

export class WalletService {
  /**
   * Logs a pending deposit transaction.
   */
  static async createPendingDeposit(
    userId,
    amount,
    description,
    pakasirOrderId,
    paymentUrl,
    paymentMethod,
    paymentNumber,
    expiredAt = null,
    feeAmount = 0
  ) {
    const currentBalance = await this.getCurrentBalance(userId);

    try {
      await pool.query(
        `
        INSERT INTO wallet_transactions (user_id, type, amount, fee_amount, balance_after, description, pakasir_order_id, payment_url, payment_method, payment_number, status, expired_at)
        VALUES ($1, 'deposit', $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
      `,
        [
          userId,
          amount || 0,
          feeAmount || 0,
          currentBalance,
          description || 'Top-up',
          pakasirOrderId,
          paymentUrl || null,
          paymentMethod || null,
          paymentNumber || null,
          expiredAt,
        ]
      );
    } catch (err) {
      console.error('[WalletService] Database error in createPendingDeposit:', err);
      throw new Error(`DB Error: ${err.message}`);
    }

    return true;
  }

  /**
   * Marks a pending deposit as failed (expired or canceled).
   */
  static async failDeposit(pakasirOrderId) {
    try {
      await pool.query(
        'UPDATE wallet_transactions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE pakasir_order_id = $2 AND status = $3',
        ['failed', pakasirOrderId, 'pending']
      );
      return true;
    } catch (err) {
      console.error('[WalletService] Error in failDeposit:', err);
      return false;
    }
  }

  /**
   * Completes a pending deposit and updates user balance.
   */
  static async completeDeposit(userId, pakasirOrderId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Find the pending transaction
      const txResult = await client.query(
        'SELECT amount, status FROM wallet_transactions WHERE pakasir_order_id = $1 AND status = $2 FOR UPDATE',
        [pakasirOrderId, 'pending']
      );

      if (txResult.rows.length === 0) {
        // Might already be completed or not found
        await client.query('ROLLBACK');
        return false;
      }

      const amount = parseFloat(txResult.rows[0].amount);

      // 2. Update user balance
      const balanceResult = await client.query(
        `
        INSERT INTO user_wallets (user_id, balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          balance = user_wallets.balance + EXCLUDED.balance,
          updated_at = CURRENT_TIMESTAMP
        RETURNING balance
      `,
        [userId, amount]
      );

      const newBalance = balanceResult.rows[0].balance;

      // 3. Update transaction to completed
      await client.query(
        `
        UPDATE wallet_transactions 
        SET status = 'completed', balance_after = $1, updated_at = CURRENT_TIMESTAMP
        WHERE pakasir_order_id = $2
      `,
        [newBalance, pakasirOrderId]
      );

      await client.query('COMMIT');
      return newBalance;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Internal helper to get current balance.
   */
  static async getCurrentBalance(userId) {
    const res = await pool.query('SELECT balance FROM user_wallets WHERE user_id = $1', [userId]);
    return parseFloat(res.rows[0]?.balance || 0);
  }

  /**
   * Adds balance to a user's wallet and logs the transaction.
   * (Direct version, used for manual adjustments etc.)
   */
  static async addBalance(userId, amount, description, pakasirOrderId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update wallet balance
      // We use INSERT ... ON CONFLICT because even though we backfilled,
      // it's safer to handle cases where a record might be missing.
      const result = await client.query(
        `
        INSERT INTO user_wallets (user_id, balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          balance = user_wallets.balance + EXCLUDED.balance,
          updated_at = CURRENT_TIMESTAMP
        RETURNING balance
      `,
        [userId, amount]
      );

      const newBalance = result.rows[0].balance;

      // 2. Log transaction
      await client.query(
        `
        INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, pakasir_order_id, status)
        VALUES ($1, 'deposit', $2, $3, $4, $5, 'completed')
      `,
        [userId, amount, newBalance, description, pakasirOrderId]
      );

      await client.query('COMMIT');
      console.log(`[Wallet] Added ${amount} to User ${userId}. New balance: ${newBalance}`);
      return newBalance;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[Wallet] Failed to add balance for User ${userId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deducts balance from a user's wallet.
   * @param {number} userId - The user ID.
   * @param {number} amount - The amount to deduct (positive number).
   * @param {string} description - Description for the transaction history.
   * @param {number} [referenceId] - Optional reference ID (e.g., subscription ID).
   * @returns {Promise<number>} - The new balance.
   * @throws {Error} - If balance is insufficient.
   */
  static async deductBalance(userId, amount, description, referenceId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Get current balance with lock to prevent race conditions
      const walletResult = await client.query(
        'SELECT balance FROM user_wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const currentBalance = parseFloat(walletResult.rows[0].balance);

      if (currentBalance < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      const newBalance = currentBalance - amount;

      // 2. Update balance
      await client.query(
        'UPDATE user_wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2',
        [newBalance, userId]
      );

      // 3. Log transaction
      await client.query(
        `
        INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, pakasir_order_id, status)
        VALUES ($1, 'deduction', $2, $3, $4, $5, 'completed')
      `,
        [userId, -amount, newBalance, description, referenceId]
      );

      await client.query('COMMIT');
      console.log(`[Wallet] Deducted ${amount} from User ${userId}. New balance: ${newBalance}`);
      return newBalance;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.message !== 'INSUFFICIENT_BALANCE') {
        console.error(`[Wallet] Failed to deduct balance for User ${userId}:`, error);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Gets the wallet balance and history for a user.
   */
  static async getWalletData(userId, page = 1, limit = 10, search = '') {
    const offset = (page - 1) * limit;
    
    const wallet = await pool.query('SELECT balance FROM user_wallets WHERE user_id = $1', [
      userId,
    ]);

    let queryParams = [userId, limit, offset];
    let whereClause = 'WHERE wt.user_id = $1';

    if (search) {
      whereClause += ` AND (wt.description ILIKE $4 OR i.invoice_number ILIKE $4 OR si.invoice_number ILIKE $4)`;
      queryParams.push(`%${search}%`);
    }
    
    const history = await pool.query(
      `SELECT wt.*, 
              COALESCE(i.invoice_number, si.invoice_number) as invoice_number
       FROM wallet_transactions wt 
       LEFT JOIN invoices i ON wt.invoice_id = i.id
       LEFT JOIN system_invoices si ON wt.system_invoice_id = si.id
       ${whereClause}
       ORDER BY wt.created_at DESC 
       LIMIT $2 OFFSET $3`,
      queryParams
    );

    const countRes = await pool.query(
      `SELECT COUNT(*) 
       FROM wallet_transactions wt 
       LEFT JOIN invoices i ON wt.invoice_id = i.id
       LEFT JOIN system_invoices si ON wt.system_invoice_id = si.id
       ${whereClause}`,
      search ? [userId, `%${search}%`] : [userId]
    );

    return {
      balance: wallet.rows[0]?.balance || 0,
      history: history.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      limit
    };
  }
}
