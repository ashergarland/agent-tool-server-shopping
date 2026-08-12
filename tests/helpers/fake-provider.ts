import { notFound } from '../../src/errors.js';
import type {
  ImmersiveProductRequest,
  ImmersiveProductResult,
  SearchProductsRequest,
  SearchProductsResult,
  ShoppingProvider,
} from '../../src/provider/types.js';

/**
 * Deterministic, network-free ShoppingProvider used by unit and integration tests. Mirrors the
 * shapes produced by SerpApiProvider without making any real HTTP calls.
 */

/** Fixed, deterministic attribution timestamp used by every fixture in this fake provider. */
export const FAKE_RETRIEVED_AT = '2024-01-01T00:00:00.000Z';

export class FakeShoppingProvider implements ShoppingProvider {
  public searchCalls: SearchProductsRequest[] = [];
  public immersiveCalls: ImmersiveProductRequest[] = [];

  public searchProducts(request: SearchProductsRequest): Promise<SearchProductsResult> {
    this.searchCalls.push(request);
    const products = [
      {
        id: 'immersive-token-1',
        detailsAvailable: true,
        title: 'Widget Pro 3000',
        seller: 'Acme Store',
        productUrl: 'https://shopping.example.com/widget-pro-3000',
        price: { amount: 29.99, currency: 'USD' },
        rating: 4.6,
        reviewsCount: 128,
        condition: 'New',
        extensions: ['Sale'],
      },
      {
        id: 'product-id-2',
        detailsAvailable: false,
        title: 'Mystery Gadget (no immersive page)',
        seller: 'Budget Bazaar',
        price: { amount: 9.99 },
        rating: undefined,
        reviewsCount: undefined,
        condition: undefined,
        extensions: undefined,
      },
      {
        id: 'immersive-token-3',
        detailsAvailable: true,
        title: 'Unpriced Curio',
        seller: 'Rare Finds',
        price: undefined,
        rating: 4.9,
        reviewsCount: 4,
        condition: 'Used',
        extensions: undefined,
      },
    ].slice(0, request.maxResults);
    return Promise.resolve({
      products,
      attribution: {
        provider: 'SerpApi (Google Shopping)',
        retrievedAt: FAKE_RETRIEVED_AT,
        sourceUrl: 'https://serpapi.com/search.json?engine=google_shopping&api_key=%5BREDACTED%5D',
      },
    });
  }

  public getImmersiveProduct(request: ImmersiveProductRequest): Promise<ImmersiveProductResult> {
    this.immersiveCalls.push(request);
    if (request.pageToken === 'missing-token') {
      return Promise.reject(notFound('The shopping provider has no details for this product'));
    }
    return Promise.resolve({
      details: {
        id: request.pageToken,
        title: 'Widget Pro 3000',
        description: 'A widget for every occasion.',
        seller: 'Acme Store',
        price: { amount: 29.99, currency: 'USD' },
        rating: 4.6,
        reviewsCount: 128,
        condition: 'New',
        extensions: ['Sale'],
      },
      offers: [
        {
          sellerName: 'Acme Store',
          link: 'https://shopping.example.com/offer/acme',
          price: { amount: 29.99, currency: 'USD' },
          shippingPrice: { amount: 4.99, currency: 'USD' },
          knownDeliveredSubtotal: { amount: 34.98, currency: 'USD' },
          condition: 'New',
          rating: 4.6,
          reviewsCount: 128,
          returnPolicy: '30-day returns',
        },
        {
          sellerName: 'Budget Bazaar',
          link: 'https://shopping.example.com/offer/budget',
          price: { amount: 24.5, currency: 'USD' },
          shippingPrice: undefined,
          knownDeliveredSubtotal: undefined,
          condition: 'New',
          rating: 4.1,
          reviewsCount: 40,
          returnPolicy: undefined,
        },
        {
          sellerName: 'Discount Depot',
          link: 'https://shopping.example.com/offer/discount',
          price: { amount: 19.99, currency: 'USD' },
          shippingPrice: { amount: 2.0, currency: 'USD' },
          knownDeliveredSubtotal: { amount: 21.99, currency: 'USD' },
          condition: 'Used - Like New',
          rating: 4.0,
          reviewsCount: 12,
          returnPolicy: undefined,
        },
        {
          sellerName: 'No Price Shop',
          link: undefined,
          price: undefined,
          shippingPrice: undefined,
          knownDeliveredSubtotal: undefined,
          condition: undefined,
          rating: undefined,
          reviewsCount: undefined,
          returnPolicy: undefined,
        },
      ],
      relatedProducts: [
        {
          id: 'immersive-token-related-1',
          detailsAvailable: true,
          title: 'Widget Pro 2000',
          seller: 'Acme Store',
          price: { amount: 19.99, currency: 'USD' },
          rating: 4.3,
          reviewsCount: 64,
          relationSource: 'provider_supplied',
        },
      ],
      attribution: {
        provider: 'SerpApi (Google Immersive Product)',
        retrievedAt: FAKE_RETRIEVED_AT,
        sourceUrl:
          'https://serpapi.com/search.json?engine=google_immersive_product&api_key=%5BREDACTED%5D',
      },
    });
  }
}
