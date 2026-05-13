import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import path from 'path';
import pool from '../db/pool.js';

const getS3Config = async () => {
  const result = await pool.query('SELECT s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key, s3_public_url FROM system_settings LIMIT 1');
  return result.rows[0] || {};
};

export const getIsS3Configured = async () => {
  const config = await getS3Config();
  return Boolean(config.s3_endpoint && config.s3_access_key && config.s3_secret_key && config.s3_bucket_name);
};

/**
 * Uploads a file to S3/R2
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} originalName - Original filename
 * @param {string} mimeType - File MIME type
 * @param {string} folder - Folder name in bucket (e.g. 'logos')
 * @returns {Promise<string|null>} The public URL of the uploaded file
 */
export const uploadFileToS3 = async (fileBuffer, originalName, mimeType, folder = 'uploads') => {
  const config = await getS3Config();
  
  if (!config.s3_endpoint || !config.s3_access_key || !config.s3_secret_key || !config.s3_bucket_name) {
    throw new Error('S3/R2 storage is not configured in system settings.');
  }

  const s3Client = new S3Client({
    region: config.s3_region || 'auto',
    endpoint: config.s3_endpoint,
    credentials: {
      accessKeyId: config.s3_access_key,
      secretAccessKey: config.s3_secret_key,
    },
    forcePathStyle: true, // Needed for many S3 compatible providers like MinIO or sometimes R2
  });

  const ext = path.extname(originalName);
  const randomName = crypto.randomBytes(16).toString('hex');
  const filename = `${folder}/${randomName}${ext}`;

  const command = new PutObjectCommand({
    Bucket: config.s3_bucket_name,
    Key: filename,
    Body: fileBuffer,
    ContentType: mimeType,
  });

  await s3Client.send(command);

  // Return the public URL
  if (config.s3_public_url) {
    return `${config.s3_public_url.replace(/\/$/, '')}/${filename}`;
  }
  
  // Fallback if no public URL is set
  return `${config.s3_endpoint.replace(/\/$/, '')}/${config.s3_bucket_name}/${filename}`;
};

/**
 * Deletes a file from S3/R2
 * @param {string} fileUrl - The public URL of the file to delete
 * @returns {Promise<boolean>} True if successful
 */
export const deleteFileFromS3 = async (fileUrl) => {
  if (!fileUrl) return false;
  
  try {
    const config = await getS3Config();
    if (!config.s3_endpoint || !config.s3_access_key || !config.s3_secret_key || !config.s3_bucket_name) {
      return false;
    }

    // Extract the filename (Key) from the URL
    // Handle both public URL and endpoint URL formats
    let key = '';
    
    if (config.s3_public_url && fileUrl.startsWith(config.s3_public_url)) {
      key = fileUrl.replace(config.s3_public_url, '').replace(/^\//, '');
    } else {
      // Try to parse from a generic URL
      try {
        const urlObj = new URL(fileUrl);
        // For Path-style (e.g. endpoint.com/bucket/key)
        if (urlObj.pathname.startsWith(`/${config.s3_bucket_name}/`)) {
          key = urlObj.pathname.replace(`/${config.s3_bucket_name}/`, '');
        } 
        // For Virtual-hosted-style (e.g. bucket.endpoint.com/key)
        else {
          key = urlObj.pathname.replace(/^\//, '');
        }
      } catch (e) {
        // If it's not a valid URL, maybe it's just the key
        key = fileUrl;
      }
    }

    if (!key) return false;

    // Use DeleteObjectCommand instead
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    
    const s3Client = new S3Client({
      region: config.s3_region || 'auto',
      endpoint: config.s3_endpoint,
      credentials: {
        accessKeyId: config.s3_access_key,
        secretAccessKey: config.s3_secret_key,
      },
      forcePathStyle: true,
    });

    const command = new DeleteObjectCommand({
      Bucket: config.s3_bucket_name,
      Key: decodeURIComponent(key),
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting file from S3:', error);
    return false;
  }
};
