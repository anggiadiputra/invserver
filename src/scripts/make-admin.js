import pool from '../db/pool.js';

const email = process.argv[2];

if (!email) {
  console.error('Please provide an email address: node make-admin.js user@example.com');
  process.exit(1);
}

async function makeAdmin() {
  try {
    const result = await pool.query(
      "UPDATE users SET role = 'admin' WHERE LOWER(email) = LOWER($1) RETURNING id, email, role",
      [email]
    );

    if (result.rows.length === 0) {
      console.error(`User with email ${email} not found.`);
    } else {
      console.log(`✅ Success! User ${result.rows[0].email} is now an ${result.rows[0].role}.`);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit();
  }
}

makeAdmin();
