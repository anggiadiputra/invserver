import express from 'express';
import pool from '../db/pool.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import nodemailer from 'nodemailer';

const router = express.Router();

// Get company settings (merged with global system settings for UI)
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Fetch user-specific company settings
    const companyResult = await pool.query(
      'SELECT * FROM company_settings WHERE user_id = $1',
      [req.userId]
    );

    // Fetch global system settings
    const systemResult = await pool.query('SELECT * FROM system_settings LIMIT 1');
    const systemSettings = systemResult.rows[0] || {};

    if (companyResult.rows.length === 0) {
      // If user has no record, return system values with empty company fields
      return res.json({
        ...systemSettings,
        company_name: '',
        company_email: '',
        company_phone: '',
        company_address: '',
        company_logo: '',
      });
    }

    // Merge: Global UI/Integrations + Per-User Company Info
    // Note: app_name is strictly global to ensure platform branding consistency
    const merged = {
      ...systemSettings,
      ...companyResult.rows[0],
      app_name: systemSettings.app_name
    };

    res.json(merged);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get raw system settings (Admin Only)
router.get('/system', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings LIMIT 1');
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system settings' });
  }
});

// Update global system settings (Admin Only)
router.put('/system', authMiddleware, adminOnly, async (req, res) => {
  try {
    const fields = [
      'app_name', 'primary_color', 'sidebar_color', 'company_logo',
      'turnstile_site_key', 'turnstile_secret_key', 'fonnte_token',
      'wa_invoice_template', 'wa_paid_template', 'wa_reminder_template',
      's3_endpoint', 's3_bucket_name', 's3_region', 's3_access_key', 's3_secret_key', 's3_public_url',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_email', 'smtp_from_name', 'smtp_encryption'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(req.body[field]);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    const query = `UPDATE system_settings SET ${updates.join(', ')} WHERE id = 1 RETURNING *`;
    const result = await pool.query(query, values);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('System settings update error:', error);
    res.status(500).json({ error: 'Failed to update system settings' });
  }
});

/**
 * POST /api/settings/test-s3
 * Test S3 connection from backend to avoid CORS issues
 */
router.post('/test-s3', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key } = req.body;

    console.log('S3 Test Request received:', {
      endpoint: s3_endpoint ? '***' : 'missing',
      bucket: s3_bucket_name,
      region: s3_region,
      accessKey: s3_access_key ? '***' : 'missing',
      secretKey: s3_secret_key ? '***' : 'missing',
    });

    if (!s3_endpoint || !s3_bucket_name || !s3_access_key || !s3_secret_key) {
      console.error('S3 Test: Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'All S3 fields are required (endpoint, bucket, access key, secret key)',
      });
    }

    const s3Client = new S3Client({
      endpoint: s3_endpoint,
      region: s3_region || 'us-east-1',
      credentials: {
        accessKeyId: s3_access_key,
        secretAccessKey: s3_secret_key,
      },
      forcePathStyle: true,
    });

    console.log('S3 Test: Attempting to list buckets...');
    const command = new ListBucketsCommand({});
    const response = await s3Client.send(command);

    console.log('S3 Test: Successfully connected, checking bucket:', s3_bucket_name);
    const bucketExists = response.Buckets?.some(b => b.Name === s3_bucket_name);

    if (bucketExists) {
      console.log('S3 Test: Bucket found');
      res.json({
        success: true,
        isRegistered: true,
        message: `Connection successful! Bucket "${s3_bucket_name}" found.`,
      });
    } else {
      console.log('S3 Test: Bucket not found');
      res.status(404).json({
        success: false,
        isRegistered: false,
        message: `Bucket "${s3_bucket_name}" not found. Please check the bucket name.`,
      });
    }
  } catch (error) {
    console.error('S3 test connection error:', error);
    console.error('S3 test error name:', error.name);
    console.error('S3 test error message:', error.message);
    console.error('S3 test error code:', error.code);

    let errorMessage = 'Failed to connect to S3';
    let statusCode = 400;

    if (error.name === 'CredentialsProviderError' || error.message?.includes('credentials')) {
      errorMessage = 'Invalid Access Key or Secret Key';
    } else if (error.name === 'NetworkingError' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorMessage = 'Cannot connect to S3 endpoint. Check the endpoint URL';
    } else if (error.message?.includes('NoSuchBucket')) {
      errorMessage = `Bucket "${req.body.s3_bucket_name}" not found`;
    } else if (error.message?.includes('InvalidAccessKeyId')) {
      errorMessage = 'Invalid Access Key ID';
    } else if (error.message?.includes('SignatureDoesNotMatch')) {
      errorMessage = 'Invalid Secret Key';
    } else if (error.message?.includes('CORS') || error.message?.includes('cors')) {
      errorMessage = 'CORS error - please configure CORS on your S3 bucket';
    } else if (error.message?.includes('timeout')) {
      errorMessage = 'Connection timeout - check your network and endpoint';
    } else if (error.message) {
      errorMessage = error.message;
    }

    console.error('S3 Test: Returning error:', errorMessage);
    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message,
    });
  }
});

/**
 * POST /api/settings/test-smtp
 * Test SMTP connection by sending a test email
 */
router.post('/test-smtp', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_encryption, smtp_test_target, smtp_test_message } = req.body;

    console.log('SMTP Test Request received:', {
      host: smtp_host,
      port: smtp_port,
      user: smtp_user ? '***' : 'missing',
      fromEmail: smtp_from_email,
      testTarget: smtp_test_target,
      encryption: smtp_encryption,
    });

    if (!smtp_host || !smtp_port || !smtp_user || !smtp_pass || !smtp_from_email || !smtp_test_target) {
      console.error('SMTP Test: Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'All SMTP fields and test target email are required',
      });
    }

    // Configure transporter based on encryption
    let secure = false;
    let tls = {};

    if (smtp_encryption === 'ssl') {
      secure = true;
    } else if (smtp_encryption === 'tls') {
      secure = false;
      tls = { rejectUnauthorized: false };
    } else if (smtp_encryption === 'none') {
      secure = false;
      tls = { rejectUnauthorized: false };
    }

    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port: parseInt(smtp_port, 10),
      secure: secure,
      auth: {
        user: smtp_user,
        pass: smtp_pass,
      },
      tls: tls,
      connectionTimeout: 10000, // 10 seconds
    });

    console.log('SMTP Test: Sending test email to:', smtp_test_target);
    
    // Send test email
    const info = await transporter.sendMail({
      from: smtp_from_name ? `"${smtp_from_name}" <${smtp_from_email}>` : smtp_from_email,
      to: smtp_test_target,
      subject: `Test Email from ${appName}`,
      text: smtp_test_message || `This is a test email from ${appName}. If you received this, your SMTP configuration is working correctly!`,
      html: smtp_test_message 
        ? `<p>${smtp_test_message}</p><hr><p><small>This is a test email from <strong>${appName}</strong></small></p>`
        : `<p>This is a test email from <strong>${appName}</strong>.</p><p>If you received this, your SMTP configuration is working correctly!</p>`,
    });

    console.log('SMTP Test: Email sent successfully, messageId:', info.messageId);
    res.json({
      success: true,
      message: `Test email sent successfully to ${smtp_test_target}! Check your inbox (and spam folder).`,
    });
  } catch (error) {
    console.error('SMTP test connection error:', error);
    console.error('SMTP test error name:', error.name);
    console.error('SMTP test error message:', error.message);
    console.error('SMTP test error code:', error.code);

    let errorMessage = 'Failed to send test email';
    let statusCode = 400;

    if (error.code === 'EAUTH' || error.message?.includes('Authentication')) {
      errorMessage = 'Authentication failed. Check your username and password';
    } else if (error.code === 'ECONNECTION' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      errorMessage = 'Cannot connect to SMTP server. Check the host and port';
    } else if (error.code === 'ETLS' || error.message?.includes('TLS')) {
      errorMessage = 'TLS/SSL error. Check your encryption settings';
    } else if (error.code === 'EENVELOPE' || error.message?.includes('recipient')) {
      errorMessage = 'Invalid recipient email address';
    } else if (error.message?.includes('timeout')) {
      errorMessage = 'Connection timeout - check your network and server';
    } else if (error.message) {
      errorMessage = error.message;
    }

    console.error('SMTP Test: Returning error:', errorMessage);
    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message,
    });
  }
});

// Update company settings
router.put('/', authMiddleware, async (req, res) => {
  try {
    const {
      company_name, company_email, company_phone, company_address, company_logo,
      turnstile_site_key, turnstile_secret_key, fonnte_token, fonnte_test_target, 
      wa_invoice_template, wa_paid_template, wa_reminder_template,
      email_invoice_template, email_paid_template, email_reminder_template,
      s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key, s3_public_url,
      smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_encryption,
      smtp_test_target,
      bank_name, bank_account_name, bank_account_number,
      app_name
    } = req.body;
    const { company_city, company_province, company_country, company_postal_code, company_mobile_phone, company_website,
      province_id, regency_id, district_id, village_id,
      province_name, regency_name, district_name, village_name } = req.body;

    // Check if settings exist
    const existing = await pool.query(
      'SELECT * FROM company_settings WHERE user_id = $1',
      [req.userId]
    );

    let result;
    if (existing.rows.length === 0) {
      // Create new settings
      result = await pool.query(
        `INSERT INTO company_settings (
          user_id, company_name, company_email, company_phone, company_address,
          company_logo, turnstile_site_key, turnstile_secret_key, fonnte_token, fonnte_test_target, 
          wa_invoice_template, wa_paid_template, wa_reminder_template,
          email_invoice_template, email_paid_template, email_reminder_template,
          s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key, s3_public_url,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_encryption,
          smtp_test_target,
          bank_name, bank_account_name, bank_account_number,
          province_name, regency_name, district_name, village_name
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46)
         RETURNING *`,
        [
          req.userId, company_name, company_email, company_phone, company_address,
          company_logo, turnstile_site_key, turnstile_secret_key, fonnte_token, fonnte_test_target, 
          wa_invoice_template, wa_paid_template, wa_reminder_template,
          email_invoice_template, email_paid_template, email_reminder_template,
          s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key, s3_public_url,
          smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_encryption,
          smtp_test_target,
          bank_name, bank_account_name, bank_account_number,
          province_name, regency_name, district_name, village_name
        ]
      );
    } else {
      // Build dynamic UPDATE query for partial updates
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (company_name !== undefined) {
        updates.push(`company_name = $${paramIndex}`);
        values.push(company_name);
        paramIndex++;
      }
      if (company_email !== undefined) {
        updates.push(`company_email = $${paramIndex}`);
        values.push(company_email);
        paramIndex++;
      }
      if (company_phone !== undefined) {
        updates.push(`company_phone = $${paramIndex}`);
        values.push(company_phone);
        paramIndex++;
      }
      if (company_address !== undefined) {
        updates.push(`company_address = $${paramIndex}`);
        values.push(company_address);
        paramIndex++;
      }
      if (company_logo !== undefined) {
        updates.push(`company_logo = $${paramIndex}`);
        values.push(company_logo);
        paramIndex++;
      }
      if (turnstile_site_key !== undefined) {
        updates.push(`turnstile_site_key = $${paramIndex}`);
        values.push(turnstile_site_key);
        paramIndex++;
      }
      if (turnstile_secret_key !== undefined) {
        updates.push(`turnstile_secret_key = $${paramIndex}`);
        values.push(turnstile_secret_key);
        paramIndex++;
      }
      if (fonnte_token !== undefined) {
        updates.push(`fonnte_token = $${paramIndex}`);
        values.push(fonnte_token);
        paramIndex++;
      }
      if (fonnte_test_target !== undefined) {
        updates.push(`fonnte_test_target = $${paramIndex}`);
        values.push(fonnte_test_target);
        paramIndex++;
      }
      if (wa_invoice_template !== undefined) {
        updates.push(`wa_invoice_template = $${paramIndex}`);
        values.push(wa_invoice_template);
        paramIndex++;
      }
      if (wa_paid_template !== undefined) {
        updates.push(`wa_paid_template = $${paramIndex}`);
        values.push(wa_paid_template);
        paramIndex++;
      }
      if (wa_reminder_template !== undefined) {
        updates.push(`wa_reminder_template = $${paramIndex}`);
        values.push(wa_reminder_template);
        paramIndex++;
      }
      if (email_invoice_template !== undefined) {
        updates.push(`email_invoice_template = $${paramIndex}`);
        values.push(email_invoice_template);
        paramIndex++;
      }
      if (email_paid_template !== undefined) {
        updates.push(`email_paid_template = $${paramIndex}`);
        values.push(email_paid_template);
        paramIndex++;
      }
      if (email_reminder_template !== undefined) {
        updates.push(`email_reminder_template = $${paramIndex}`);
        values.push(email_reminder_template);
        paramIndex++;
      }
      if (s3_endpoint !== undefined) {
        updates.push(`s3_endpoint = $${paramIndex}`);
        values.push(s3_endpoint);
        paramIndex++;
      }
      if (s3_bucket_name !== undefined) {
        updates.push(`s3_bucket_name = $${paramIndex}`);
        values.push(s3_bucket_name);
        paramIndex++;
      }
      if (s3_region !== undefined) {
        updates.push(`s3_region = $${paramIndex}`);
        values.push(s3_region);
        paramIndex++;
      }
      if (s3_access_key !== undefined) {
        updates.push(`s3_access_key = $${paramIndex}`);
        values.push(s3_access_key);
        paramIndex++;
      }
      if (s3_secret_key !== undefined) {
        updates.push(`s3_secret_key = $${paramIndex}`);
        values.push(s3_secret_key);
        paramIndex++;
      }
      if (s3_public_url !== undefined) {
        updates.push(`s3_public_url = $${paramIndex}`);
        values.push(s3_public_url);
        paramIndex++;
      }
      if (smtp_host !== undefined) {
        updates.push(`smtp_host = $${paramIndex}`);
        values.push(smtp_host);
        paramIndex++;
      }
      if (smtp_port !== undefined) {
        updates.push(`smtp_port = $${paramIndex}`);
        values.push(smtp_port);
        paramIndex++;
      }
      if (smtp_user !== undefined) {
        updates.push(`smtp_user = $${paramIndex}`);
        values.push(smtp_user);
        paramIndex++;
      }
      if (smtp_pass !== undefined) {
        updates.push(`smtp_pass = $${paramIndex}`);
        values.push(smtp_pass);
        paramIndex++;
      }
      if (smtp_from_email !== undefined) {
        updates.push(`smtp_from_email = $${paramIndex}`);
        values.push(smtp_from_email);
        paramIndex++;
      }
      if (smtp_from_name !== undefined) {
        updates.push(`smtp_from_name = $${paramIndex}`);
        values.push(smtp_from_name);
        paramIndex++;
      }
      if (smtp_encryption !== undefined) {
        updates.push(`smtp_encryption = $${paramIndex}`);
        values.push(smtp_encryption);
        paramIndex++;
      }
      if (smtp_test_target !== undefined) {
        updates.push(`smtp_test_target = $${paramIndex}`);
        values.push(smtp_test_target);
        paramIndex++;
      }
      if (bank_name !== undefined) {
        updates.push(`bank_name = $${paramIndex}`);
        values.push(bank_name);
        paramIndex++;
      }
      if (bank_account_name !== undefined) {
        updates.push(`bank_account_name = $${paramIndex}`);
        values.push(bank_account_name);
        paramIndex++;
      }
      if (bank_account_number !== undefined) {
        updates.push(`bank_account_number = $${paramIndex}`);
        values.push(bank_account_number);
        paramIndex++;
      }
      if (req.body.company_city !== undefined) {
        updates.push(`company_city = $${paramIndex}`);
        values.push(req.body.company_city);
        paramIndex++;
      }
      if (req.body.company_province !== undefined) {
        updates.push(`company_province = $${paramIndex}`);
        values.push(req.body.company_province);
        paramIndex++;
      }
      if (req.body.company_country !== undefined) {
        updates.push(`company_country = $${paramIndex}`);
        values.push(req.body.company_country);
        paramIndex++;
      }
      if (req.body.company_postal_code !== undefined) {
        updates.push(`company_postal_code = $${paramIndex}`);
        values.push(req.body.company_postal_code);
        paramIndex++;
      }
      if (req.body.company_mobile_phone !== undefined) {
        updates.push(`company_mobile_phone = $${paramIndex}`);
        values.push(req.body.company_mobile_phone);
        paramIndex++;
      }
      if (req.body.company_website !== undefined) {
        updates.push(`company_website = $${paramIndex}`);
        values.push(req.body.company_website);
        paramIndex++;
      }
      if (province_id !== undefined) {
        updates.push(`province_id = $${paramIndex}`);
        values.push(province_id);
        paramIndex++;
      }
      if (regency_id !== undefined) {
        updates.push(`regency_id = $${paramIndex}`);
        values.push(regency_id);
        paramIndex++;
      }
      if (district_id !== undefined) {
        updates.push(`district_id = $${paramIndex}`);
        values.push(district_id);
        paramIndex++;
      }
      if (village_id !== undefined) {
        updates.push(`village_id = $${paramIndex}`);
        values.push(village_id);
        paramIndex++;
      }
      if (province_name !== undefined) {
        updates.push(`province_name = $${paramIndex}`);
        values.push(province_name);
        paramIndex++;
      }
      if (regency_name !== undefined) {
        updates.push(`regency_name = $${paramIndex}`);
        values.push(regency_name);
        paramIndex++;
      }
      if (district_name !== undefined) {
        updates.push(`district_name = $${paramIndex}`);
        values.push(district_name);
        paramIndex++;
      }
      if (village_name !== undefined) {
        updates.push(`village_name = $${paramIndex}`);
        values.push(village_name);
        paramIndex++;
      }

      // Always update timestamp
      updates.push('updated_at = CURRENT_TIMESTAMP');

      if (updates.length === 1) {
        // Only timestamp was added, no fields to update
        return res.status(400).json({ error: 'No fields to update' });
      }

      // Add user_id as the last parameter
      values.push(req.userId);
      const userIdParam = paramIndex;

      const query = `
        UPDATE company_settings
        SET ${updates.join(', ')}
        WHERE user_id = $${userIdParam}
        RETURNING *
      `;

      result = await pool.query(query, values);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating settings:', error.message);
    console.error('Full error:', error);
    console.error('Request body:', req.body);
    console.error('User ID:', req.userId);
    res.status(500).json({ error: 'Failed to update settings', details: error.message });
  }
});

export default router;
