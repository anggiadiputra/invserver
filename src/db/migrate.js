import dotenv from 'dotenv';
dotenv.config();
import pool from './pool.js';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        clerk_id VARCHAR(255) UNIQUE,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        company_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create index on email for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    // Ensure clerk_id exists for existing installations
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'users' AND column_name = 'clerk_id') THEN
          ALTER TABLE users ADD COLUMN clerk_id VARCHAR(255) UNIQUE;
        END IF;
        
        IF (SELECT is_nullable FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'password_hash') = 'NO' THEN
          ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
        END IF;
      END $$;
    `);

    // Create company_settings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_name VARCHAR(255) NOT NULL,
        company_email VARCHAR(255),
        company_phone VARCHAR(20),
        company_address TEXT,
        company_logo TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      );
    `);

    // Create customers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20),
        address TEXT,
        city VARCHAR(100),
        postal_code VARCHAR(20),
        country VARCHAR(100),
        province_id VARCHAR(20),
        regency_id VARCHAR(20),
        district_id VARCHAR(20),
        village_id VARCHAR(20),
        province_name VARCHAR(100),
        regency_name VARCHAR(100),
        district_name VARCHAR(100),
        village_name VARCHAR(100),
        is_self BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create services table
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        tax_rate DECIMAL(5, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create invoices table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        invoice_number VARCHAR(50) NOT NULL UNIQUE,
        issue_date DATE NOT NULL,
        due_date DATE NOT NULL,
        total_amount DECIMAL(12, 2) NOT NULL,
        tax_amount DECIMAL(12, 2) DEFAULT 0,
        paid_amount DECIMAL(12, 2) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'draft',
        invoice_type VARCHAR(20) DEFAULT 'regular',
        system_ref_id VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create invoice_items table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        service_id INTEGER REFERENCES services(id),
        description VARCHAR(255) NOT NULL,
        quantity DECIMAL(10, 2) NOT NULL,
        unit_price DECIMAL(10, 2) NOT NULL,
        tax_rate DECIMAL(5, 2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
    `);

    // Add neon_user_id to users
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS neon_user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_neon_id ON users(neon_user_id);
    `);

    // Create logs tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        subject VARCHAR(255),
        invoice_id INTEGER,
        status VARCHAR(50) DEFAULT 'sent',
        error_message TEXT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS auth_logs (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        message TEXT,
        details JSONB
      );
    `);

    // Add new columns to customers table if they don't exist
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'province_id') THEN
          ALTER TABLE customers ADD COLUMN province_id VARCHAR(20);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'regency_id') THEN
          ALTER TABLE customers ADD COLUMN regency_id VARCHAR(20);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'district_id') THEN
          ALTER TABLE customers ADD COLUMN district_id VARCHAR(20);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'village_id') THEN
          ALTER TABLE customers ADD COLUMN village_id VARCHAR(20);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'province_name') THEN
          ALTER TABLE customers ADD COLUMN province_name VARCHAR(100);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'regency_name') THEN
          ALTER TABLE customers ADD COLUMN regency_name VARCHAR(100);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'district_name') THEN
          ALTER TABLE customers ADD COLUMN district_name VARCHAR(100);
        END IF;
        
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'village_name') THEN
          ALTER TABLE customers ADD COLUMN village_name VARCHAR(100);
        END IF;
      END $$;
    `);

    // Add templates columns to company_settings if they don't exist
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'wa_invoice_template') THEN
          ALTER TABLE company_settings ADD COLUMN wa_invoice_template TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'wa_paid_template') THEN
          ALTER TABLE company_settings ADD COLUMN wa_paid_template TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'wa_reminder_template') THEN
          ALTER TABLE company_settings ADD COLUMN wa_reminder_template TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'email_invoice_template') THEN
          ALTER TABLE company_settings ADD COLUMN email_invoice_template TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'email_paid_template') THEN
          ALTER TABLE company_settings ADD COLUMN email_paid_template TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'company_settings' AND column_name = 'email_reminder_template') THEN
          ALTER TABLE company_settings ADD COLUMN email_reminder_template TEXT;
        END IF;
      END $$;
    `);



    // Add discount column to invoice_items if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoice_items' AND column_name = 'discount') THEN
          ALTER TABLE invoice_items ADD COLUMN discount DECIMAL(5, 2) DEFAULT 0;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoice_items' AND column_name = 'unit') THEN
          ALTER TABLE invoice_items ADD COLUMN unit VARCHAR(50);
        END IF;
      END $$;
    `);

    // Add display preference columns to invoices table
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoices' AND column_name = 'show_discount') THEN
          ALTER TABLE invoices ADD COLUMN show_discount BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoices' AND column_name = 'show_unit') THEN
          ALTER TABLE invoices ADD COLUMN show_unit BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoices' AND column_name = 'show_tax') THEN
          ALTER TABLE invoices ADD COLUMN show_tax BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'plans' AND column_name = 'description') THEN
          ALTER TABLE plans ADD COLUMN description TEXT;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'plans' AND column_name = 'updated_at') THEN
          ALTER TABLE plans ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'invoices' AND column_name = 'expires_at') THEN
          ALTER TABLE invoices ADD COLUMN expires_at TIMESTAMP;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'customers' AND column_name = 'is_self') THEN
          ALTER TABLE customers ADD COLUMN is_self BOOLEAN DEFAULT false;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'invoices' AND column_name = 'invoice_type') THEN
          ALTER TABLE invoices ADD COLUMN invoice_type VARCHAR(20) DEFAULT 'regular';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'invoices' AND column_name = 'system_ref_id') THEN
          ALTER TABLE invoices ADD COLUMN system_ref_id VARCHAR(100);
        END IF;

        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                      WHERE table_name = 'wallet_transactions' AND column_name = 'invoice_id') THEN
          ALTER TABLE wallet_transactions ADD COLUMN invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Set expires_at for existing invoices (40 days from created_at)
    await client.query(`
      UPDATE invoices SET expires_at = created_at + INTERVAL '40 days'
      WHERE expires_at IS NULL;
    `);


    // Create bank_accounts table for multiple bank accounts
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bank_name VARCHAR(255) NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        account_number VARCHAR(100) NOT NULL,
        is_primary BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_accounts_user_id ON bank_accounts(user_id);
    `);


    // Create whatsapp_logs table for tracking sent messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target VARCHAR(20) NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        invoice_id INTEGER REFERENCES invoices(id),
        status VARCHAR(50) DEFAULT 'sent',
        error_message TEXT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_user_id ON whatsapp_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_invoice_id ON whatsapp_logs(invoice_id);
    `);
    // RBAC: Add role column to users table
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'users' AND column_name = 'role') THEN
          ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'member'
            CHECK (role IN ('admin', 'member'));
        END IF;

        -- Add status column to users
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'users' AND column_name = 'status') THEN
          ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
        END IF;

        -- Add status column to customers
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'customers' AND column_name = 'status') THEN
          ALTER TABLE customers ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
        END IF;

        -- Add status column to services
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'services' AND column_name = 'status') THEN
          ALTER TABLE services ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
        END IF;

      END $$;
    `);

    // RBAC: Create system_settings table (singleton)
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY,
        app_name VARCHAR(100) DEFAULT 'Invoizes - Pro Billing System',
        company_logo TEXT,
        turnstile_site_key TEXT,
        turnstile_secret_key TEXT,
        fonnte_token TEXT,
        wa_invoice_template TEXT,
        wa_paid_template TEXT,
        wa_reminder_template TEXT,
        s3_endpoint TEXT,
        s3_bucket_name TEXT,
        s3_region VARCHAR(100),
        s3_access_key TEXT,
        s3_secret_key TEXT,
        s3_public_url TEXT,
        smtp_host VARCHAR(255),
        smtp_port INTEGER DEFAULT 587,
        smtp_user TEXT,
        smtp_pass TEXT,
        smtp_from_email TEXT,
        smtp_from_name VARCHAR(255),
        smtp_encryption VARCHAR(10) DEFAULT 'tls',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed system_settings if empty
    const systemRes = await client.query('SELECT COUNT(*) FROM system_settings');
    if (parseInt(systemRes.rows[0].count) === 0) {
      await client.query('INSERT INTO system_settings DEFAULT VALUES');
      console.log('✅ Seeded default system_settings');
    }

    // --- SAAS TABLES (Restored) ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(50) UNIQUE NOT NULL,
        price_monthly DECIMAL(10,2) DEFAULT 0,
        description TEXT,
        max_invoices INT DEFAULT 10,
        max_customers INT DEFAULT 50,
        features JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        status VARCHAR(20) DEFAULT 'trial',
        started_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_wallets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance DECIMAL(12,2) DEFAULT 0,
        total_deposited DECIMAL(12,2) DEFAULT 0,
        total_spent DECIMAL(12,2) DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        type VARCHAR(20) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        balance_after DECIMAL(12,2) NOT NULL,
        description TEXT,
        pakasir_order_id VARCHAR(100),
        invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'completed',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Ensure description column exists in plans (for existing tables)
      ALTER TABLE plans ADD COLUMN IF NOT EXISTS description TEXT;
    `);

    // Seed initial plans if empty
    const plansCount = await client.query('SELECT COUNT(*) FROM plans');
    if (parseInt(plansCount.rows[0].count) === 0) {
      await client.query(`
        INSERT INTO plans (name, slug, description, price_monthly, max_invoices, max_customers, features) VALUES
          ('Gratis',  'free',    'Cocok untuk personal dan UMKM kecil', 0,      10,  50,  '{"email": false, "whatsapp": false}'),
          ('Starter', 'starter', 'Untuk bisnis berkembang', 49000,  100, 500, '{"email": true,  "whatsapp": false}'),
          ('Pro',     'pro',     'Fitur lengkap untuk bisnis profesional', 149000, -1,  -1,  '{"email": true,  "whatsapp": true}')
      `);
      console.log('✅ Seeded default plans');
    }

    // --- DATA NORMALIZATION & IDENTITY MERGING (formerly in server.js) ---
    console.log('🔄 Running data normalization and user identity merging...');
    await client.query(`
      DO $$ 
      DECLARE
          r RECORD;
          target_id INTEGER;
          source_ids INTEGER[];
          old_id INTEGER;
          new_id INTEGER;
      BEGIN
          -- 1. Identify and merge duplicate users based on lowercase email
          FOR r IN (
              SELECT LOWER(email) as lemail, ARRAY_AGG(id ORDER BY (neon_user_id IS NOT NULL) DESC, created_at ASC) as ids
              FROM users
              GROUP BY LOWER(email)
              HAVING COUNT(*) > 1
          ) LOOP
              target_id := r.ids[1];
              source_ids := r.ids[2:]; 

              UPDATE customers SET user_id = target_id WHERE user_id = ANY(source_ids);
              UPDATE services SET user_id = target_id WHERE user_id = ANY(source_ids);
              UPDATE invoices SET user_id = target_id WHERE user_id = ANY(source_ids);
              UPDATE bank_accounts SET user_id = target_id WHERE user_id = ANY(source_ids);
              
              IF NOT EXISTS (SELECT 1 FROM company_settings WHERE user_id = target_id) THEN
                  UPDATE company_settings SET user_id = target_id 
                  WHERE id = (SELECT id FROM company_settings WHERE user_id = ANY(source_ids) ORDER BY updated_at DESC LIMIT 1);
              END IF;
              DELETE FROM company_settings WHERE user_id = ANY(source_ids);
              DELETE FROM users WHERE id = ANY(source_ids);
          END LOOP;

          -- 2. Normalize all remaining emails to lowercase
          UPDATE users SET email = LOWER(email);

          -- 3. Identity Swap: Rename sini@diurusin.id to anggiadiputra@gmail.com if possible
          SELECT id INTO old_id FROM users WHERE LOWER(email) = 'sini@diurusin.id';
          SELECT id INTO new_id FROM users WHERE LOWER(email) = 'anggiadiputra@gmail.com';

          IF (old_id IS NOT NULL AND new_id IS NULL) THEN
              UPDATE users SET email = 'anggiadiputra@gmail.com' WHERE id = old_id;
          ELSIF (old_id IS NOT NULL AND new_id IS NOT NULL AND old_id != new_id) THEN
              UPDATE customers SET user_id = new_id WHERE user_id = old_id;
              UPDATE invoices SET user_id = new_id WHERE user_id = old_id;
              UPDATE services SET user_id = new_id WHERE user_id = old_id;
              DELETE FROM users WHERE id = old_id;
          END IF;
      END $$;
    `);

    console.log('✅ Migrations and restoration completed successfully');

  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
