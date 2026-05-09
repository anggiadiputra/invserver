import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.unstable_mockModule('../src/db/pool.js', () => ({
  __esModule: true,
  default: mockPool,
}));

jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  __esModule: true,
  authMiddleware: (req, res, next) => next(),
  adminOnly: (req, res, next) => next(),
  generateToken: (userId) => `mock-token-${userId}`,
  verifyToken: () => null,
}));

jest.unstable_mockModule('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: mockCreateTransport,
  },
}));

const request = (await import('supertest')).default;
const { default: app } = await import('../src/server.js');

describe('POST /api/settings/test-smtp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_NAME = 'Invoizes Test';
  });

  it('returns 400 when required SMTP fields are missing', async () => {
    const res = await request(app).post('/api/settings/test-smtp').send({
      smtp_host: 'smtp.example.com',
      smtp_port: '587',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.message).toMatch(/All SMTP fields and test target email are required/i);
  });

  it('sends a test email and returns success when SMTP config is valid', async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: 'test-id' });

    const res = await request(app).post('/api/settings/test-smtp').send({
      smtp_host: 'smtp.example.com',
      smtp_port: '587',
      smtp_user: 'user@example.com',
      smtp_pass: 'password',
      smtp_from_email: 'noreply@example.com',
      smtp_from_name: 'Invoizes Team',
      smtp_encryption: 'tls',
      smtp_test_target: 'test@example.com',
      smtp_test_message: 'Testing SMTP configuration',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      message: expect.stringContaining('Test email sent successfully'),
    });
    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        auth: { user: 'user@example.com', pass: 'password' },
      })
    );
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Invoizes Team" <noreply@example.com>',
        to: 'test@example.com',
        subject: 'Test Email from Invoizes Test',
      })
    );
  });
});
