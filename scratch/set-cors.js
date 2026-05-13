import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import pool from '../src/db/pool.js';

const setCors = async () => {
  try {
    const result = await pool.query('SELECT s3_endpoint, s3_bucket_name, s3_region, s3_access_key, s3_secret_key FROM system_settings LIMIT 1');
    const config = result.rows[0];

    if (!config || !config.s3_endpoint) {
      console.error('S3 configuration not found in database.');
      process.exit(1);
    }

    const s3Client = new S3Client({
      region: config.s3_region || 'auto',
      endpoint: config.s3_endpoint,
      credentials: {
        accessKeyId: config.s3_access_key,
        secretAccessKey: config.s3_secret_key,
      },
      forcePathStyle: true,
    });

    const command = new PutBucketCorsCommand({
      Bucket: config.s3_bucket_name,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['GET', 'HEAD'],
            AllowedOrigins: ['*'],
            ExposeHeaders: ['ETag'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    });

    await s3Client.send(command);
    console.log(`✅ CORS configuration successfully applied to bucket: ${config.s3_bucket_name}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to set CORS:', error);
    process.exit(1);
  }
};

setCors();
