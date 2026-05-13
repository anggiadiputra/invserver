import { S3Client, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import pool from '../src/db/pool.js';

const setPolicy = async () => {
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

    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${config.s3_bucket_name}/*`]
        }
      ]
    };

    const command = new PutBucketPolicyCommand({
      Bucket: config.s3_bucket_name,
      Policy: JSON.stringify(policy),
    });

    await s3Client.send(command);
    console.log(`✅ Bucket policy set to public read for bucket: ${config.s3_bucket_name}`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to set bucket policy:', error);
    process.exit(1);
  }
};

setPolicy();
