import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('🔍 Identifying duplicate users by email (case-insensitive)...');
    
    // Find groups of users with same lowercase email
    const res = await client.query(`
      SELECT LOWER(email) as lower_email, COUNT(*) as count, ARRAY_AGG(id ORDER BY created_at ASC) as ids
      FROM users
      GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    `);
    
    console.log(`Found ${res.rows.length} duplicate groups.`);
    
    for (const group of res.rows) {
      const { lower_email, ids } = group;
      // We keep the one that possibly has neon_user_id, or just the first one created.
      // Let's refine: find the one with neon_user_id if available.
      const userDetails = await client.query('SELECT id, neon_user_id FROM users WHERE id = ANY($1)', [ids]);
      const targetUser = userDetails.rows.find(u => u.neon_user_id) || userDetails.rows[0];
      const sourceUserIds = ids.filter(id => id !== targetUser.id);
      
      console.log(`Merging users [${sourceUserIds}] into target user ${targetUser.id} (${lower_email})`);
      
      const tables = ['customers', 'services', 'invoices', 'bank_accounts', 'whatsapp_logs', 'email_logs', 'company_settings'];
      
      for (const table of tables) {
        if (table === 'company_settings') {
            // company_settings has UNIQUE(user_id), so we delete sources first or update only if target doesn't have one
            const targetSettings = await client.query('SELECT id FROM company_settings WHERE user_id = $1', [targetUser.id]);
            if (targetSettings.rows.length > 0) {
                await client.query('DELETE FROM company_settings WHERE user_id = ANY($1)', [sourceUserIds]);
            } else {
                await client.query('UPDATE company_settings SET user_id = $1 WHERE user_id = ANY($2)', [targetUser.id, sourceUserIds]);
                // If multiple sources had settings, this might still fail. So let's be safer:
                await client.query('DELETE FROM company_settings WHERE id NOT IN (SELECT MIN(id) FROM company_settings GROUP BY user_id)');
            }
        } else {
            await client.query(`UPDATE ${table} SET user_id = $1 WHERE user_id = ANY($2)`, [targetUser.id, sourceUserIds]);
        }
      }
      
      // Delete duplicate users
      await client.query('DELETE FROM users WHERE id = ANY($1)', [sourceUserIds]);
      console.log(`✅ Merged data for ${lower_email}`);
    }
    
    await client.query('COMMIT');
    console.log('🚀 Cleanup completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Cleanup failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

cleanup();
