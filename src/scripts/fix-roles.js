import pool from '../db/pool.js';

async function fixRoles() {
  try {
    // Set anggiadiputra@gmail.com as admin
    const res1 = await pool.query(
      "UPDATE users SET role = 'admin' WHERE LOWER(email) = LOWER($1) RETURNING email, role",
      ['anggiadiputra@gmail.com']
    );

    if (res1.rows.length > 0) {
      console.log(`✅ ${res1.rows[0].email} is now ${res1.rows[0].role}`);
    } else {
      console.log(`❌ User anggiadiputra@gmail.com not found.`);
    }

    // Set idgosite@gmail.com as member
    const res2 = await pool.query(
      "UPDATE users SET role = 'member' WHERE LOWER(email) = LOWER($1) RETURNING email, role",
      ['idgosite@gmail.com']
    );

    if (res2.rows.length > 0) {
      console.log(`✅ ${res2.rows[0].email} is now ${res2.rows[0].role}`);
    } else {
      console.log(`❌ User idgosite@gmail.com not found.`);
    }
  } catch (err) {
    console.error('Error fixing roles:', err);
  } finally {
    process.exit();
  }
}

fixRoles();
