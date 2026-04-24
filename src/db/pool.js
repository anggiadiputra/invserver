import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool, types } = pkg;

// Force TIMESTAMP (OID 1114) to be parsed as UTC
// This prevents the 'pg' driver from shifting times based on local server timezone
types.setTypeParser(1114, (stringValue) => {
  return new Date(stringValue.replace(' ', 'T') + 'Z');
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export default pool;
