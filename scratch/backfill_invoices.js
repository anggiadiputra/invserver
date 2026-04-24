import { generateSystemInvoice } from '../src/utils/systemInvoices.js';
import pool from '../src/db/pool.js';

async function backfill() {
  console.log('Backfilling system invoices...');
  try {
    const txs = await pool.query(
      "SELECT * FROM wallet_transactions WHERE status = 'completed' AND system_invoice_id IS NULL AND (description LIKE '%Top-up%' OR description LIKE '%Paket%' OR description LIKE '%Upgrade%')"
    );
    
    console.log(`Found ${txs.rows.length} transactions to backfill.`);
    
    for (const tx of txs.rows) {
      try {
        const type = tx.type === 'deposit' ? 'topup' : 'subscription';
        const amount = Math.abs(parseFloat(tx.amount));
        
        console.log(`Processing TX ${tx.id} (${tx.description})...`);
        await generateSystemInvoice(tx.user_id, type, amount, tx.description, tx.pakasir_order_id);
        console.log(`✅ Generated invoice for TX ${tx.id}`);
      } catch (e) {
        console.error(`❌ Failed for TX ${tx.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    process.exit(0);
  }
}

backfill();
