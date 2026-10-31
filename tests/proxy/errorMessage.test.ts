import { describe, expect, it } from 'vitest';
import { formatUpstreamErrorMessage } from '../../src/proxy/errorMessage';

describe('formatUpstreamErrorMessage', () => {
  it('falls back to the Axios error message when response data is circular', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const err = {
      isAxiosError: true,
      message: 'socket hang up',
      response: {
        data: circular,
      },
    };

    expect(formatUpstreamErrorMessage(err)).toBe('socket hang up');
  });

  it('prefers a serializable upstream payload when present', () => {
    const err = {
      isAxiosError: true,
      message: 'Request failed with status code 429',
      response: {
        data: {
          error: {
            message: 'Rate limit exceeded',
          },
        },
      },
    };

    expect(formatUpstreamErrorMessage(err)).toBe('Rate limit exceeded');
  });
});