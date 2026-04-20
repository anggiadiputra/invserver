import pool from '../db/pool.js';

export class WalletService {
  /**
   * Adds balance to a user's wallet and logs the transaction.
   * @param {number} userId - The user ID.
   * @param {number} amount - The amount to add.
   * @param {string} description - Description for the transaction history.
   * @param {string} [pakasirOrderId] - Optional reference to a Pakasir order.
   * @returns {Promise<number>} - The new balance.
   */
  static async addBalance(userId, amount, description, pakasirOrderId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update wallet balance
      // We use INSERT ... ON CONFLICT because even though we backfilled,
      // it's safer to handle cases where a record might be missing.
      const result = await client.query(`
        INSERT INTO user_wallets (user_id, balance)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          balance = user_wallets.balance + EXCLUDED.balance,
          updated_at = CURRENT_TIMESTAMP
        RETURNING balance
      `, [userId, amount]);

      const newBalance = result.rows[0].balance;

      // 2. Log transaction
      await client.query(`
        INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, pakasir_order_id, status)
        VALUES ($1, 'deposit', $2, $3, $4, $5, 'completed')
      `, [userId, amount, newBalance, description, pakasirOrderId]);

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
      await client.query(`
        INSERT INTO wallet_transactions (user_id, type, amount, balance_after, description, status)
        VALUES ($1, 'deduction', $2, $3, $4, 'completed')
      `, [userId, -amount, newBalance, description]);

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
  static async getWalletData(userId) {
    const wallet = await pool.query('SELECT balance FROM user_wallets WHERE user_id = $1', [userId]);
    const history = await pool.query(
      'SELECT * FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );

    return {
      balance: wallet.rows[0]?.balance || 0,
      history: history.rows
    };
  }
}
