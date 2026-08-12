import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { redactUrl, SerpApiProvider } from '../../src/provider/serpapi.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const baseOptions = {
  apiKey: 'test-key',
  baseUrl: 'https://serpapi.example.com',
  timeoutMs: 5_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

describe('redactUrl', () => {
  it('replaces the api_key query parameter', () => {
    const url = new URL(
      'https://serpapi.example.com/search.json?engine=google_shopping&api_key=super-secret&q=widget',
    );
    expect(redactUrl(url)).not.toContain('super-secret');
    expect(redactUrl(url)).toContain('api_key=%5BREDACTED%5D');
    expect(redactUrl(url)).toContain('q=widget');
  });
});

describe('SerpApiProvider.searchProducts', () => {
  it('normalizes shopping_results, preferring the immersive page token as id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        shopping_results: [
          {
            title: 'Widget Pro',
            product_id: 'pid-1',
            immersive_product_page_token: 'token-1',
            source: 'Acme Store',
            product_link: 'https://example.com/widget',
            extracted_price: 19.99,
            currency: 'USD',
            rating: 4.5,
            reviews: 100,
            condition: 'New',
            extensions: ['Sale'],
          },
          {
            title: 'No Token Item',
            product_id: 'pid-2',
            extracted_price: 5,
          },
          { title: 'Missing id fields' },
          { product_id: 'pid-no-title' },
        ],
      }),
    );
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchProducts({
      query: 'widget',
      maxResults: 10,
      forceFresh: false,
    });

    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      id: 'token-1',
      detailsAvailable: true,
      title: 'Widget Pro',
      seller: 'Acme Store',
      price: { amount: 19.99, currency: 'USD' },
    });
    expect(result.products[1]).toMatchObject({
      id: 'pid-2',
      detailsAvailable: false,
      price: { amount: 5 },
    });
    expect(result.products[1]?.price?.currency).toBeUndefined();
    expect(result.attribution.provider).toBe('SerpApi (Google Shopping)');

    const [requestUrl] = fetchImpl.mock.calls[0] as [URL];
    expect(requestUrl.searchParams.get('engine')).toBe('google_shopping');
    expect(requestUrl.searchParams.get('q')).toBe('widget');
    expect(requestUrl.searchParams.get('api_key')).toBe('test-key');
  });

  it('never invents a currency when the provider omits one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        shopping_results: [{ title: 'No currency', product_id: 'pid-3', extracted_price: 12.34 }],
      }),
    );
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    const result = await provider.searchProducts({
      query: 'widget',
      maxResults: 10,
      forceFresh: false,
    });
    expect(result.products[0]?.price).toEqual({ amount: 12.34 });
  });

  it('appends no_cache=true when forceFresh is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ shopping_results: [] }));
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    await provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: true });
    const [requestUrl] = fetchImpl.mock.calls[0] as [URL];
    expect(requestUrl.searchParams.get('no_cache')).toBe('true');
  });
});

describe('SerpApiProvider.getImmersiveProduct', () => {
  it('normalizes details, offers, and related products', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        product_results: {
          title: 'Widget Pro',
          description: 'A fine widget.',
          extracted_price: 19.99,
          currency: 'USD',
          rating: 4.5,
          reviews: 100,
          condition: 'New',
          stores: [
            {
              name: 'Acme Store',
              link: 'https://example.com/acme',
              extracted_price: 19.99,
              currency: 'USD',
              extracted_shipping: 4.99,
              condition: 'New',
              rating: 4.5,
              reviews: 100,
              return_policy: '30 days',
            },
            {
              name: 'No Shipping Store',
              extracted_price: 15,
              currency: 'USD',
            },
            { extracted_price: 10 },
          ],
          related_products: [
            {
              title: 'Widget Lite',
              immersive_product_page_token: 'related-token',
              extracted_price: 9.99,
              currency: 'USD',
              rating: 4.0,
              reviews: 20,
            },
          ],
        },
      }),
    );
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    const result = await provider.getImmersiveProduct({
      pageToken: 'token-1',
      forceFresh: false,
    });

    expect(result.details).toMatchObject({
      id: 'token-1',
      title: 'Widget Pro',
      description: 'A fine widget.',
      price: { amount: 19.99, currency: 'USD' },
    });
    expect(result.offers).toHaveLength(2);
    expect(result.offers[0]).toMatchObject({
      sellerName: 'Acme Store',
      price: { amount: 19.99, currency: 'USD' },
      shippingPrice: { amount: 4.99, currency: 'USD' },
      knownDeliveredSubtotal: { amount: 24.98, currency: 'USD' },
    });
    expect(result.offers[1]).toMatchObject({ sellerName: 'No Shipping Store' });
    expect(result.offers[1]?.knownDeliveredSubtotal).toBeUndefined();
    expect(result.relatedProducts).toEqual([
      {
        id: 'related-token',
        detailsAvailable: true,
        title: 'Widget Lite',
        seller: undefined,
        price: { amount: 9.99, currency: 'USD' },
        rating: 4.0,
        reviewsCount: 20,
        relationSource: 'provider_supplied',
      },
    ]);
    expect(result.attribution.provider).toBe('SerpApi (Google Immersive Product)');
  });

  it('throws not_found when the provider has no product_results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    await expect(
      provider.getImmersiveProduct({ pageToken: 'missing', forceFresh: false }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('SerpApiProvider error handling', () => {
  it('maps a provider "no results" error message to not_found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Google hasn't returned any results for this query." }),
      );
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('maps another provider error message to a non-retryable upstream_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'Invalid API key.' }));
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'upstream_error', retryable: false });
  });

  it('maps a 429 response to rate_limited', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('retries a transient 500 and eventually succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ shopping_results: [] }));
    const provider = new SerpApiProvider({
      ...baseOptions,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      fetchImpl,
    });
    const result = await provider.searchProducts({
      query: 'widget',
      maxResults: 10,
      forceFresh: false,
    });
    expect(result.products).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after exhausting retries on a persistent 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const provider = new SerpApiProvider({
      ...baseOptions,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      fetchImpl,
    });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'upstream_error', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a network failure to a retryable upstream_error and logs without leaking the api key', async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new SerpApiProvider({ ...baseOptions, fetchImpl, logger });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'upstream_error', retryable: true });
    expect(warn).toHaveBeenCalled();
    const loggedUrl = String(warn.mock.calls[0]?.[0]?.url ?? '');
    expect(loggedUrl).not.toContain('test-key');
  });

  it('times out a hanging request', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: URL, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('This operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const provider = new SerpApiProvider({ ...baseOptions, timeoutMs: 20, fetchImpl });
    await expect(
      provider.searchProducts({ query: 'widget', maxResults: 10, forceFresh: false }),
    ).rejects.toMatchObject({ code: 'upstream_error', retryable: true });
  });
});
