import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import customerRoutes from './routes/customers.js';
import serviceRoutes from './routes/services.js';
import invoiceRoutes from './routes/invoices.js';
import settingsRoutes from './routes/settings.js';
import bankAccountRoutes from './routes/bankAccounts.js';
import regionRoutes from './routes/regions.js';
import fonnteRoutes from './routes/fonnte.js';
import emailRoutes from './routes/emails.js';
import publicRoutes from './routes/public.js';
import userRoutes from './routes/users.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || /^http:\/\/localhost:\d+$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/fonnte', fonnteRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/users', userRoutes);

// Public invoice redirect (redirect backend links to frontend)
app.get('/public/invoice/:id', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.redirect(`${frontendUrl}/public/invoice/${req.params.id}`);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Only listen if not running as a Vercel serverless function
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

export default app;
