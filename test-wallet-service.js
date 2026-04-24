import pool from './src/db/pool.js';
import { WalletService } from './src/services/wallet.js';

async function test() {
  try {
    console.log('Testing createPendingDeposit...');
    await WalletService.createPendingDeposit(
      1,
      10000,
      'Test Deposit',
      'TEST-ORDER-' + Date.now(),
      'https://example.com/pay',
      'qris',
      '12345'
    );
    console.log('Success!');
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
}

test();
