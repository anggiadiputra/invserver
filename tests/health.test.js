import { describe, expect, it, jest } from '@jest/globals';

const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

jest.unstable_mockModule('../src/db/pool.js', () => ({
  __esModule: true,
  default: mockPool,
}));

const request = (await import('supertest')).default;
const { default: app } = await import('../src/server.js');

describe('GET /health', () => {
  it('should return 200 OK', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });
});
