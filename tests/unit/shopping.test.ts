import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { createServices } from '../../src/services/index.js';
import { FakeShoppingProvider } from '../helpers/fake-provider.js';
import { testConfig } from '../helpers/config.js';

describe('shopping service', () => {
  it('searches products and passes through attribution', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.searchProducts({ query: 'widget' });
    expect(result.query).toBe('widget');
    expect(result.resultCount).toBe(result.products.length);
    expect(result.attribution.provider).toBe('SerpApi (Google Shopping)');
    expect(result.products.length).toBeGreaterThan(0);
  });

  it('clamps maxResults to the configured maximum', async () => {
    const provider = new FakeShoppingProvider();
    const services = createServices(
      testConfig({ SHOPPING_MAX_RESULTS: 2, SHOPPING_DEFAULT_RESULTS: 2 }),
      provider,
    );
    await services.shopping.searchProducts({ query: 'widget', maxResults: 50 });
    expect(provider.searchCalls[0]?.maxResults).toBe(2);
  });

  it('rejects an inverted price range', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    await expect(
      services.shopping.searchProducts({ query: 'widget', minPrice: 100, maxPrice: 10 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('conservatively excludes products with an unknown price when a price filter is set', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.searchProducts({ query: 'widget', minPrice: 0 });
    expect(result.products.every((product) => product.price !== undefined)).toBe(true);
  });

  it('conservatively excludes products with an unknown rating when a rating filter is set', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.searchProducts({ query: 'widget', minRating: 4 });
    expect(result.products.every((product) => (product.rating ?? 0) >= 4)).toBe(true);
  });

  it('gets product details for a valid id', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.getProductDetails({ id: 'immersive-token-1' });
    expect(result.product.title).toBe('Widget Pro 3000');
    expect(result.attribution.provider).toBe('SerpApi (Google Immersive Product)');
  });

  it('propagates a not_found error for an unknown product id', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    await expect(
      services.shopping.getProductDetails({ id: 'missing-token' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists product offers', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.getProductOffers({ id: 'immersive-token-1' });
    expect(result.offerCount).toBe(result.offers.length);
    expect(result.offers.length).toBeGreaterThan(0);
  });

  it('computes knownDeliveredSubtotal only when price and shipping are both known', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.getProductOffers({ id: 'immersive-token-1' });
    const acme = result.offers.find((offer) => offer.sellerName === 'Acme Store');
    const budget = result.offers.find((offer) => offer.sellerName === 'Budget Bazaar');
    expect(acme?.knownDeliveredSubtotal).toEqual({ amount: 34.98, currency: 'USD' });
    expect(budget?.knownDeliveredSubtotal).toBeUndefined();
  });

  it('compares offers by knownDeliveredSubtotal by default, excluding offers without one', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.compareOffers({ id: 'immersive-token-1', maxResults: 1 });
    expect(result.sortBy).toBe('knownDeliveredSubtotal');
    // Offers with only a bare price (unknown shipping) are conservatively excluded, since they
    // are not comparable to a true price+shipping subtotal.
    expect(result.offers.every((ranked) => ranked.offer.knownDeliveredSubtotal !== undefined)).toBe(
      true,
    );
    expect(result.offers.every((ranked) => ranked.deliveredSubtotalKnown)).toBe(true);
    expect(result.offers[0]?.rank).toBe(1);
    // Discount Depot's known delivered subtotal (21.99) is lower than Acme's (34.98).
    expect(result.offers[0]?.offer.sellerName).toBe('Discount Depot');
    expect(result.comparedOfferCount).toBe(result.offers.length);
    expect(result.comparedOfferCount).toBe(1);
    expect(result.mixedCurrencies).toBe(false);
  });

  it('compares offers by rating, excluding offers without a rating', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.compareOffers({
      id: 'immersive-token-1',
      sortBy: 'rating',
    });
    expect(result.offers[0]?.offer.sellerName).toBe('Acme Store');
    expect(result.offers.every((ranked) => ranked.offer.rating !== undefined)).toBe(true);
  });

  it('finds similar products labeled as provider-supplied', async () => {
    const services = createServices(testConfig(), new FakeShoppingProvider());
    const result = await services.shopping.findSimilarProducts({ id: 'immersive-token-1' });
    expect(result.relatedProductCount).toBe(result.relatedProducts.length);
    expect(
      result.relatedProducts.every((product) => product.relationSource === 'provider_supplied'),
    ).toBe(true);
  });

  it('wires an injectable application', async () => {
    const application = createApplication({
      config: testConfig(),
      provider: new FakeShoppingProvider(),
    });
    expect(application.registry.list()).toHaveLength(5);
    await application.http.close();
  });
});
