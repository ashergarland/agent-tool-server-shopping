/**
 * Provider-neutral shopping domain types.
 *
 * These types describe what the service layer needs, not what any single upstream API returns.
 * `src/provider/serpapi.ts` is the only file allowed to know about SerpApi request/response
 * shapes; everything else in the codebase depends solely on the interfaces declared here.
 *
 * Normalization rules the adapter must uphold (see also src/provider/serpapi.ts):
 * - Never infer a currency. `Money.currency` is only populated when the upstream payload states
 *   an explicit ISO-4217 code; otherwise it is left `undefined`.
 * - Never infer shipping cost or availability. Those fields are only populated when the upstream
 *   payload explicitly states them; a missing shipping price is not treated as free shipping, and
 *   a missing availability flag is not treated as in-stock.
 * - Every result carries `attribution` so callers can show provenance and freshness.
 */

/** A monetary amount. `currency` is omitted whenever the source did not explicitly state one. */
export interface Money {
  readonly amount: number;
  readonly currency?: string | undefined;
}

/** Provenance and freshness metadata attached to every provider response. */
export interface Attribution {
  /** Human-readable name of the upstream provider and engine that produced the data. */
  readonly provider: string;
  /** ISO-8601 timestamp of when this data was fetched from the upstream provider. */
  readonly retrievedAt: string;
  /** Canonical result URL supplied by the provider, when available. */
  readonly sourceUrl?: string | undefined;
}

/** A single item returned from a product search. */
export interface ProductSummary {
  /**
   * Provider-supplied identifier for this listing. Pass this value as `id` to
   * shopping_get_product_details, shopping_get_product_offers, shopping_compare_offers, or
   * shopping_find_similar_products. Not every listing supports detail lookups; if the provider
   * did not supply a token for the immersive product page, `detailsAvailable` is `false`.
   */
  readonly id: string;
  readonly detailsAvailable: boolean;
  readonly title: string;
  readonly seller?: string | undefined;
  readonly productUrl?: string | undefined;
  readonly price?: Money | undefined;
  readonly rating?: number | undefined;
  readonly reviewsCount?: number | undefined;
  readonly condition?: string | undefined;
  /** Short provider-supplied tags such as "Sale" or "Special offer", passed through verbatim. */
  readonly extensions?: readonly string[] | undefined;
}

export interface SearchProductsRequest {
  readonly query: string;
  readonly countryCode?: string;
  readonly languageCode?: string;
  readonly maxResults: number;
  readonly forceFresh: boolean;
}

export interface SearchProductsResult {
  readonly products: readonly ProductSummary[];
  readonly attribution: Attribution;
}

/** Detailed information about a single product, sourced from the immersive product page. */
export interface ProductDetails {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly seller?: string | undefined;
  readonly price?: Money | undefined;
  readonly rating?: number | undefined;
  readonly reviewsCount?: number | undefined;
  readonly condition?: string | undefined;
  readonly extensions?: readonly string[] | undefined;
}

/**
 * A single seller offer for a product. `shippingPrice` and `knownDeliveredSubtotal` are only
 * populated when the provider explicitly stated a shipping cost; they are never inferred.
 */
export interface Offer {
  readonly sellerName: string;
  readonly link?: string | undefined;
  readonly price?: Money | undefined;
  readonly shippingPrice?: Money | undefined;
  /**
   * Sum of `price` and `shippingPrice`, populated only when both are known and share the same
   * currency (or neither has an explicit currency). This intentionally avoids the ambiguous term
   * "total", since tax and other charges may still be unknown.
   */
  readonly knownDeliveredSubtotal?: Money | undefined;
  readonly condition?: string | undefined;
  readonly rating?: number | undefined;
  readonly reviewsCount?: number | undefined;
  readonly returnPolicy?: string | undefined;
}

/** A related product surfaced by the provider. Similarity is provider-supplied, not computed. */
export interface RelatedProduct {
  readonly id: string;
  readonly detailsAvailable: boolean;
  readonly title: string;
  readonly seller?: string | undefined;
  readonly price?: Money | undefined;
  readonly rating?: number | undefined;
  readonly reviewsCount?: number | undefined;
  readonly relationSource: 'provider_supplied';
}

export interface ImmersiveProductRequest {
  readonly pageToken: string;
  readonly forceFresh: boolean;
}

export interface ImmersiveProductResult {
  readonly details: ProductDetails;
  readonly offers: readonly Offer[];
  readonly relatedProducts: readonly RelatedProduct[];
  readonly attribution: Attribution;
}

/**
 * Domain port for the read-only shopping data source. `src/provider/serpapi.ts` is the shipped
 * adapter, backed only by the `google_shopping` and `google_immersive_product` SerpApi engines.
 * Replace this interface and its adapter without changing transports or services.
 */
export interface ShoppingProvider {
  searchProducts(request: SearchProductsRequest): Promise<SearchProductsResult>;
  getImmersiveProduct(request: ImmersiveProductRequest): Promise<ImmersiveProductResult>;
}
