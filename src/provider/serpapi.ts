import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError, notFound } from '../errors.js';
import type {
  Attribution,
  ImmersiveProductRequest,
  ImmersiveProductResult,
  Money,
  Offer,
  ProductDetails,
  ProductSummary,
  RelatedProduct,
  SearchProductsRequest,
  SearchProductsResult,
  ShoppingProvider,
} from './types.js';

/**
 * Read-only adapter over two SerpApi engines: `google_shopping` (search) and
 * `google_immersive_product` (details, offers, and related products for one listing).
 * No other SerpApi engine is used. This adapter performs no application-level caching; every
 * call reaches the upstream provider (optionally bypassing SerpApi's own cache via `no_cache`).
 */

type JsonRecord = Record<string, unknown>;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asStringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

/** Only accepts an explicit ISO-4217-shaped currency code; never guesses one. */
const readCurrency = (node: JsonRecord): string | undefined => {
  const currency = asString(node['currency']);
  return currency && CURRENCY_PATTERN.test(currency) ? currency : undefined;
};

/** Reads a monetary amount only from an explicit numeric field; never parses price strings. */
const readMoney = (node: JsonRecord, extractedKey: string): Money | undefined => {
  const amount = asNumber(node[extractedKey]);
  if (amount === undefined) return undefined;
  const currency = readCurrency(node);
  return currency === undefined ? { amount } : { amount, currency };
};

const sameCurrency = (a: Money | undefined, b: Money | undefined): boolean =>
  a?.currency === b?.currency;

/** price + shipping, only when both are known and expressed in a compatible currency. */
const knownDeliveredSubtotal = (
  price: Money | undefined,
  shippingPrice: Money | undefined,
): Money | undefined => {
  if (!price || !shippingPrice || !sameCurrency(price, shippingPrice)) return undefined;
  // Round away binary floating-point noise (e.g. 19.99 + 4.99) without truncating
  // precision used by any real-world currency's minor units.
  const amount = Math.round((price.amount + shippingPrice.amount) * 1e6) / 1e6;
  return price.currency === undefined ? { amount } : { amount, currency: price.currency };
};

const toProductSummary = (node: unknown): ProductSummary | undefined => {
  if (!isRecord(node)) return undefined;
  const title = asString(node['title']);
  const rawId = asString(node['immersive_product_page_token']) ?? asString(node['product_id']);
  if (!title || !rawId) return undefined;
  return {
    id: rawId,
    detailsAvailable: asString(node['immersive_product_page_token']) !== undefined,
    title,
    seller: asString(node['source']),
    productUrl: asString(node['product_link']) ?? asString(node['link']),
    price: readMoney(node, 'extracted_price'),
    rating: asNumber(node['rating']),
    reviewsCount: asNumber(node['reviews']),
    condition: asString(node['condition']),
    extensions: asStringArray(node['extensions']),
  };
};

const toRelatedProduct = (node: unknown): RelatedProduct | undefined => {
  if (!isRecord(node)) return undefined;
  const title = asString(node['title']);
  const rawId = asString(node['immersive_product_page_token']) ?? asString(node['product_id']);
  if (!title || !rawId) return undefined;
  return {
    id: rawId,
    detailsAvailable: asString(node['immersive_product_page_token']) !== undefined,
    title,
    seller: asString(node['source']),
    price: readMoney(node, 'extracted_price'),
    rating: asNumber(node['rating']),
    reviewsCount: asNumber(node['reviews']),
    relationSource: 'provider_supplied',
  };
};

const toOffer = (node: unknown): Offer | undefined => {
  if (!isRecord(node)) return undefined;
  const sellerName = asString(node['name']) ?? asString(node['source']);
  if (!sellerName) return undefined;
  const price = readMoney(node, 'extracted_price');
  const shippingPrice = readMoney(node, 'extracted_shipping');
  return {
    sellerName,
    link: asString(node['link']),
    price,
    shippingPrice,
    knownDeliveredSubtotal: knownDeliveredSubtotal(price, shippingPrice),
    condition: asString(node['condition']),
    rating: asNumber(node['rating']),
    reviewsCount: asNumber(node['reviews']),
    returnPolicy: asString(node['return_policy']),
  };
};

const toProductDetails = (id: string, node: JsonRecord): ProductDetails => ({
  id,
  title: asString(node['title']) ?? 'Untitled product',
  description: asString(node['description']),
  seller: asString(node['seller']) ?? asString(node['source']),
  price: readMoney(node, 'extracted_price'),
  rating: asNumber(node['rating']),
  reviewsCount: asNumber(node['reviews']),
  condition: asString(node['condition']),
  extensions: asStringArray(node['extensions']),
});

/** Removes the API key from a URL before it is ever logged or included in an error. */
export const redactUrl = (url: URL): string => {
  const redacted = new URL(url.toString());
  if (redacted.searchParams.has('api_key')) redacted.searchParams.set('api_key', '[REDACTED]');
  return redacted.toString();
};

const isTransient = (status: number): boolean => status === 429 || status >= 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface SerpApiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly logger?: Logger | undefined;
  readonly fetchImpl?: typeof fetch;
}

export class SerpApiProvider implements ShoppingProvider {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: SerpApiProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public static fromConfig(config: AppConfig, logger?: Logger): SerpApiProvider {
    return new SerpApiProvider({ ...config.shopping.serpApi, logger });
  }

  public async searchProducts(request: SearchProductsRequest): Promise<SearchProductsResult> {
    const url = this.buildUrl('google_shopping', {
      q: request.query,
      gl: request.countryCode,
      hl: request.languageCode,
    });
    const payload = await this.fetchJson(url, request.forceFresh);
    const results = Array.isArray(payload['shopping_results']) ? payload['shopping_results'] : [];
    const products = results
      .map(toProductSummary)
      .filter((product): product is ProductSummary => product !== undefined)
      .slice(0, request.maxResults);
    return { products, attribution: this.attribution('google_shopping', url) };
  }

  public async getImmersiveProduct(
    request: ImmersiveProductRequest,
  ): Promise<ImmersiveProductResult> {
    const url = this.buildUrl('google_immersive_product', { page_token: request.pageToken });
    const payload = await this.fetchJson(url, request.forceFresh);
    const productResults = payload['product_results'];
    if (!isRecord(productResults)) {
      throw notFound('The shopping provider has no details for this product identifier');
    }
    const stores = Array.isArray(productResults['stores']) ? productResults['stores'] : [];
    const related =
      (Array.isArray(productResults['related_products']) && productResults['related_products']) ||
      (Array.isArray(productResults['similar_products']) && productResults['similar_products']) ||
      [];
    return {
      details: toProductDetails(request.pageToken, productResults),
      offers: stores.map(toOffer).filter((offer): offer is Offer => offer !== undefined),
      relatedProducts: related
        .map(toRelatedProduct)
        .filter((product): product is RelatedProduct => product !== undefined),
      attribution: this.attribution('google_immersive_product', url),
    };
  }

  private attribution(
    engine: 'google_shopping' | 'google_immersive_product',
    url: URL,
  ): Attribution {
    return {
      provider:
        engine === 'google_shopping'
          ? 'SerpApi (Google Shopping)'
          : 'SerpApi (Google Immersive Product)',
      retrievedAt: new Date().toISOString(),
      sourceUrl: redactUrl(url),
    };
  }

  private buildUrl(
    engine: 'google_shopping' | 'google_immersive_product',
    params: Record<string, string | undefined>,
  ): URL {
    const url = new URL('/search.json', this.options.baseUrl);
    url.searchParams.set('engine', engine);
    url.searchParams.set('api_key', this.options.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
    }
    return url;
  }

  private async fetchJson(url: URL, forceFresh: boolean): Promise<JsonRecord> {
    const requestUrl = new URL(url.toString());
    if (forceFresh) requestUrl.searchParams.set('no_cache', 'true');

    let lastError: AppError | undefined;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImpl(requestUrl, { signal: controller.signal });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          if (isTransient(response.status) && attempt < this.options.maxRetries) {
            this.options.logger?.warn(
              { event: 'provider.http_error', status: response.status, url: redactUrl(requestUrl) },
              'shopping provider returned a transient error status; retrying',
            );
            await sleep(this.retryDelay(attempt));
            continue;
          }
          throw response.status === 429
            ? new AppError(
                'rate_limited',
                'The shopping provider rate limit was exceeded',
                undefined,
                true,
              )
            : this.upstreamError(response.status, requestUrl);
        }
        if (!isRecord(body)) {
          throw new AppError(
            'upstream_error',
            'The shopping provider returned an unexpected response',
            undefined,
            false,
          );
        }
        const errorMessage = asString(body['error']);
        if (errorMessage) {
          this.options.logger?.warn(
            { event: 'provider.error', url: redactUrl(requestUrl), providerMessage: errorMessage },
            'shopping provider reported an error',
          );
          throw /no results|not found|hasn't returned any results/i.test(errorMessage)
            ? notFound(`The shopping provider found no results: ${errorMessage}`)
            : new AppError(
                'upstream_error',
                `The shopping provider rejected the request: ${errorMessage}`,
                undefined,
                false,
              );
        }
        return body;
      } catch (error) {
        if (error instanceof AppError) throw error;
        const timedOut = error instanceof Error && error.name === 'AbortError';
        lastError = new AppError(
          'upstream_error',
          timedOut ? 'The shopping provider timed out' : 'The shopping provider was unreachable',
          undefined,
          true,
          error,
        );
        if (attempt < this.options.maxRetries) {
          await sleep(this.retryDelay(attempt));
          continue;
        }
        this.options.logger?.warn(
          { event: 'provider.unreachable', url: redactUrl(requestUrl), err: error },
          'shopping provider request failed after retries',
        );
        throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new AppError('upstream_error', 'The shopping provider request failed');
  }

  private upstreamError(status: number, url: URL): AppError {
    this.options.logger?.warn(
      { event: 'provider.http_error', status, url: redactUrl(url) },
      'shopping provider returned an error status',
    );
    return new AppError(
      'upstream_error',
      `The shopping provider rejected the request (status ${status})`,
      undefined,
      isTransient(status),
    );
  }

  private retryDelay(attempt: number): number {
    const backoff = this.options.retryBaseDelayMs * 2 ** attempt;
    const jitter = Math.random() * this.options.retryBaseDelayMs;
    return backoff + jitter;
  }
}
