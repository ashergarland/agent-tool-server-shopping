import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { SerpApiProvider } from '../../src/provider/serpapi.js';

/**
 * Optional, disabled-by-default live integration test against the real SerpApi service.
 *
 * These tests make real network calls and consume real SerpApi search credits, so they
 * are skipped unless explicitly opted into by setting both:
 *   - RUN_LIVE_SERPAPI_TESTS=true
 *   - SERPAPI_API_KEY=<a real SerpApi key>
 *
 * Run locally with:
 *   RUN_LIVE_SERPAPI_TESTS=true SERPAPI_API_KEY=... npx vitest run tests/integration/live-serpapi.test.ts
 */
const liveTestsEnabled =
  process.env['RUN_LIVE_SERPAPI_TESTS'] === 'true' && !!process.env['SERPAPI_API_KEY'];

describe.skipIf(!liveTestsEnabled)('SerpApiProvider (live)', () => {
  const provider = new SerpApiProvider({
    apiKey: process.env['SERPAPI_API_KEY'] ?? '',
    baseUrl: process.env['SERPAPI_BASE_URL'] ?? 'https://serpapi.com',
    timeoutMs: 10_000,
    maxRetries: 2,
    retryBaseDelayMs: 250,
    logger: pino({ level: 'silent' }),
  });

  it('searches for real products and returns attribution', async () => {
    const result = await provider.searchProducts({
      query: 'wireless mouse',
      maxResults: 5,
      forceFresh: false,
    });
    expect(result.attribution.provider).toBe('SerpApi (Google Shopping)');
    expect(Array.isArray(result.products)).toBe(true);
  });

  it('fetches immersive product details for a real result when available', async () => {
    const search = await provider.searchProducts({
      query: 'wireless mouse',
      maxResults: 5,
      forceFresh: false,
    });
    const withDetails = search.products.find((product) => product.detailsAvailable);
    if (!withDetails) {
      // Not all searches surface a token-backed result; skip gracefully rather than fail.
      return;
    }
    const details = await provider.getImmersiveProduct({
      pageToken: withDetails.id,
      forceFresh: false,
    });
    expect(details.details.title).toBeTruthy();
  });
});
