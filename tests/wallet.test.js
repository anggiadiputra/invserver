import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockPool = {
  query: jest.fn(),
  connect: jest.fn().mockResolvedValue(mockClient),
};

jest.unstable_mockModule('../src/db/pool.js', () => ({
  __esModule: true,
  default: mockPool,
}));

const { WalletService } = await import('../src/services/wallet.js');

describe('WalletService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('addBalance', () => {
    it('adds a positive amount and returns the updated balance', async () => {
      mockClient.query.mockImplementationOnce(async () => ({ rows: [] })) // BEGIN
        .mockImplementationOnce(async () => ({ rows: [{ balance: 150 }] })) // INSERT user_wallets
        .mockImplementationOnce(async () => ({ rows: [] })) // INSERT wallet_transactions
        .mockImplementationOnce(async () => ({ rows: [] })); // COMMIT

      const result = await WalletService.addBalance(1, 50, 'Top-up', 'ORDER-1');

      expect(result).toBe(150);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO user_wallets'), [1, 50]);
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO wallet_transactions'), [1, 50, 150, 'Top-up', 'ORDER-1']);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('throws INVALID_AMOUNT for zero or negative amounts', async () => {
      await expect(WalletService.addBalance(1, 0, 'Top-up')).rejects.toThrow('INVALID_AMOUNT');
      await expect(WalletService.addBalance(1, -20, 'Top-up')).rejects.toThrow('INVALID_AMOUNT');
      expect(mockClient.query).not.toHaveBeenCalled();
    });
  });

  describe('deductBalance', () => {
    it('throws INVALID_AMOUNT for zero or negative amounts', async () => {
      await expect(WalletService.deductBalance(1, 0, 'Deduction')).rejects.toThrow('INVALID_AMOUNT');
      await expect(WalletService.deductBalance(1, -10, 'Deduction')).rejects.toThrow('INVALID_AMOUNT');
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('throws INSUFFICIENT_BALANCE when balance is too low', async () => {
      mockClient.query.mockImplementationOnce(async () => ({ rows: [] }))
        .mockImplementationOnce(async () => ({ rows: [{ balance: 20 }] }));

      await expect(WalletService.deductBalance(1, 50, 'Deduction')).rejects.toThrow('INSUFFICIENT_BALANCE');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('SELECT balance FROM user_wallets WHERE user_id = $1 FOR UPDATE', [1]);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('getWalletData', () => {
    it('calls wallet and history queries with correct search parameters', async () => {
      mockPool.query.mockImplementation(async (sql, params) => {
        if (sql.startsWith('SELECT balance FROM user_wallets')) {
          return { rows: [{ balance: 100 }] };
        }
        if (sql.includes('SELECT wt.*,') ) {
          return { rows: [{ id: 1, description: 'Test entry' }] };
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return { rows: [{ count: '1' }] };
        }
        return { rows: [] };
      });

      const result = await WalletService.getWalletData(2, 1, 10, 'topup');

      expect(result.balance).toBe(100);
      expect(result.history).toEqual([{ id: 1, description: 'Test entry' }]);
      expect(result.total).toBe(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN system_invoices si ON wt.system_invoice_id = si.id'),
        [2, 10, 0, '%topup%']
      );
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT COUNT(*)'),
        [2, '%topup%']
      );
    });
  });
});
