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
    // If a company field is null or empty string, fallback to system settings
    const companySettings = companyResult.rows[0];
    const merged = { ...systemSettings };

    // Keys that can be overridden by user
    const restorableKeys = [
      'company_name', 'company_email', 'company_phone', 'company_address', 'company_logo',
      'wa_invoice_template', 'wa_paid_template', 'wa_reminder_template',
      'email_invoice_template', 'email_paid_template', 'email_reminder_template'
    ];

    for (const key of restorableKeys) {
      if (companySettings[key] !== null && companySettings[key] !== undefined && companySettings[key] !== '') {
        merged[key] = companySettings[key];
      }
    }

    // Strict global settings (User cannot override)
    merged.app_name = systemSettings.app_name || 'Invoizes';
    merged.fonnte_token = systemSettings.fonnte_token;
    merged.turnstile_site_key = systemSettings.turnstile_site_key;

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
      'turnstile_site_key', 'turnstile_secret_key', 'fonnte_token', 'fonnte_test_target', 'fonnte_test_message',
      'wa_invoice_template', 'wa_paid_template', 'wa_reminder_template',
      's3_endpoint', 's3_bucket_name', 's3_region', 's3_access_key', 's3_secret_key', 's3_public_url',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from_email', 'smtp_from_name', 'smtp_encryption',
      'smtp_test_target', 'smtp_test_message'
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

// Update company settings (User-specific)
router.put('/', authMiddleware, async (req, res) => {
  try {
    const {
      company_name, company_email, company_phone, company_address, company_logo,
      wa_invoice_template, wa_paid_template, wa_reminder_template,
      email_invoice_template, email_paid_template, email_reminder_template,
      company_city, company_province, company_country, company_postal_code, company_mobile_phone, company_website,
      province_id, regency_id, district_id, village_id,
      province_name, regency_name, district_name, village_name
    } = req.body;

    // Check if settings exist
    const existing = await pool.query(
      'SELECT * FROM company_settings WHERE user_id = $1',
      [req.userId]
    );

    let result;
    if (existing.rows.length === 0) {
      // Create new settings (INSERT)
      const insertFields = [
        'user_id', 'company_name', 'company_email', 'company_phone', 'company_address', 'company_logo',
        'wa_invoice_template', 'wa_paid_template', 'wa_reminder_template',
        'email_invoice_template', 'email_paid_template', 'email_reminder_template',
        'company_city', 'company_province', 'company_country', 'company_postal_code', 'company_mobile_phone', 'company_website',
        'province_id', 'regency_id', 'district_id', 'village_id',
        'province_name', 'regency_name', 'district_name', 'village_name'
      ];

      const placeholders = insertFields.map((_, i) => `$${i + 1}`).join(', ');
      const values = [
        req.userId, company_name, company_email, company_phone, company_address, company_logo,
        wa_invoice_template, wa_paid_template, wa_reminder_template,
        email_invoice_template, email_paid_template, email_reminder_template,
        company_city, company_province, company_country, company_postal_code, company_mobile_phone, company_website,
        province_id, regency_id, district_id, village_id,
        province_name, regency_name, district_name, village_name
      ];

      const query = `INSERT INTO company_settings (${insertFields.join(', ')}) VALUES (${placeholders}) RETURNING *`;
      result = await pool.query(query, values);
    } else {
      // Build dynamic UPDATE query for partial updates
      const updates = [];
      const values = [];
      let paramIndex = 1;

      // List of allowed fields for user-specific settings
      const allowedFields = [
        'company_name', 'company_email', 'company_phone', 'company_address', 'company_logo',
        'wa_invoice_template', 'wa_paid_template', 'wa_reminder_template',
        'email_invoice_template', 'email_paid_template', 'email_reminder_template',
        'company_city', 'company_province', 'company_country', 'company_postal_code', 'company_mobile_phone', 'company_website',
        'province_id', 'regency_id', 'district_id', 'village_id',
        'province_name', 'regency_name', 'district_name', 'village_name'
      ];

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${paramIndex}`);
          values.push(req.body[field]);
          paramIndex++;
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // Always update timestamp
      updates.push('updated_at = CURRENT_TIMESTAMP');

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
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings', details: error.message });
  }
});

export default router;
