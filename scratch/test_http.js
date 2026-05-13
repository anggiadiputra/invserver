import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';

async function test() {
  const token = jwt.sign({ id: 12 }, process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
  
  const res = await fetch('http://localhost:3001/api/customers/batch-delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ ids: [999991, 999992] })
  });
  
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text);
  process.exit(0);
}
test();
