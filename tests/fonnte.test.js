import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockFetch = jest.fn();

global.fetch = mockFetch;

describe('FonnteService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns success false when Fonnte responds with status 400', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ message: 'Invalid target phone number', reason: 'Bad request' }),
    });

    const { default: fonnteService } = await import('../src/services/fonnte.js');

    const result = await fonnteService.testConnection('test-token', '628123456789');

    expect(result).toEqual({
      success: false,
      message: 'Request failed: Invalid target phone number',
      error: 'Invalid target phone number',
    });
    expect(mockFetch).toHaveBeenCalledWith('https://api.fonnte.com/send', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'test-token' }),
    }));
  });
});
