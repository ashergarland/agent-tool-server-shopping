import type { AppConfig } from '../config/index.js';
import { badRequest } from '../errors.js';
import type {
  Attribution,
  Money,
  Offer,
  ProductDetails,
  ProductSummary,
  RelatedProduct,
  ShoppingProvider,
} from '../provider/types.js';

/**
 * Business logic for the five shopping tools. Every method applies bounded defaults from config,
 * conservative post-filters (a filter only ever removes a result it can positively confirm fails
 * the condition; a result with an unknown value for the filtered field is excluded rather than
 * assumed to pass), and passes through provider attribution unchanged.
 */

export interface SearchProductsInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly countryCode?: string | undefined;
  readonly languageCode?: string | undefined;
  readonly minPrice?: number | undefined;
  readonly maxPrice?: number | undefined;
  readonly minRating?: number | undefined;
  readonly forceFresh?: boolean | undefined;
}

export interface SearchProductsOutput {
  readonly query: string;
  readonly products: readonly ProductSummary[];
  readonly resultCount: number;
  readonly attribution: Attribution;
}

export interface ProductIdInput {
  readonly id: string;
  readonly forceFresh?: boolean | undefined;
}

export interface ProductDetailsOutput {
  readonly product: ProductDetails;
  readonly attribution: Attribution;
}

export interface ProductOffersInput extends ProductIdInput {
  readonly maxResults?: number | undefined;
}

export interface ProductOffersOutput {
  readonly id: string;
  readonly offers: readonly Offer[];
  readonly offerCount: number;
  readonly attribution: Attribution;
}

export type CompareOffersSortBy = 'knownDeliveredSubtotal' | 'price' | 'rating';

export interface CompareOffersInput extends ProductIdInput {
  readonly maxResults?: number | undefined;
  readonly sortBy?: CompareOffersSortBy | undefined;
}

export interface RankedOffer {
  readonly rank: number;
  readonly offer: Offer;
  readonly deliveredSubtotalKnown: boolean;
}

export interface CompareOffersOutput {
  readonly id: string;
  readonly sortBy: CompareOffersSortBy;
  readonly comparedOfferCount: number;
  readonly mixedCurrencies: boolean;
  readonly offers: readonly RankedOffer[];
  readonly attribution: Attribution;
}

export interface FindSimilarProductsInput extends ProductIdInput {
  readonly maxResults?: number | undefined;
}

export interface FindSimilarProductsOutput {
  readonly id: string;
  readonly relatedProducts: readonly RelatedProduct[];
  readonly relatedProductCount: number;
  readonly attribution: Attribution;
}

const passesPriceFilter = (
  product: { readonly price?: Money | undefined },
  minPrice: number | undefined,
  maxPrice: number | undefined,
): boolean => {
  if (minPrice === undefined && maxPrice === undefined) return true;
  if (!product.price) return false;
  if (minPrice !== undefined && product.price.amount < minPrice) return false;
  if (maxPrice !== undefined && product.price.amount > maxPrice) return false;
  return true;
};

const passesRatingFilter = (
  product: { readonly rating?: number | undefined },
  minRating: number | undefined,
): boolean => {
  if (minRating === undefined) return true;
  return product.rating !== undefined && product.rating >= minRating;
};

const sortKey = (sortBy: CompareOffersSortBy, offer: Offer): number | undefined => {
  switch (sortBy) {
    case 'rating':
      return offer.rating;
    case 'knownDeliveredSubtotal':
      // Conservative by design: an offer with only a known price (unknown shipping) is not
      // comparable to one with a known price+shipping subtotal, so it is excluded rather than
      // silently ranked by price alone.
      return offer.knownDeliveredSubtotal?.amount;
    case 'price':
      return offer.price?.amount;
  }
};

const UNKNOWN_CURRENCY = '__unknown__';

export class ShoppingService {
  public constructor(
    private readonly provider: ShoppingProvider,
    private readonly config: AppConfig,
  ) {}

  /** Clamps a caller-requested result count to the deployment's configured bounds. */
  private clampResults(requested: number | undefined): number {
    const { defaultResults, maxResults } = this.config.shopping;
    const value = requested ?? defaultResults;
    return Math.min(Math.max(1, value), maxResults);
  }

  public async searchProducts(input: SearchProductsInput): Promise<SearchProductsOutput> {
    if (
      input.minPrice !== undefined &&
      input.maxPrice !== undefined &&
      input.minPrice > input.maxPrice
    ) {
      throw badRequest('minPrice must not be greater than maxPrice');
    }
    const result = await this.provider.searchProducts({
      query: input.query,
      countryCode: input.countryCode ?? this.config.shopping.defaultCountry,
      languageCode: input.languageCode ?? this.config.shopping.defaultLanguage,
      maxResults: this.clampResults(input.maxResults),
      forceFresh: input.forceFresh ?? false,
    });
    const products = result.products.filter(
      (product) =>
        passesPriceFilter(product, input.minPrice, input.maxPrice) &&
        passesRatingFilter(product, input.minRating),
    );
    return {
      query: input.query,
      products,
      resultCount: products.length,
      attribution: result.attribution,
    };
  }

  public async getProductDetails(input: ProductIdInput): Promise<ProductDetailsOutput> {
    const result = await this.provider.getImmersiveProduct({
      pageToken: input.id,
      forceFresh: input.forceFresh ?? false,
    });
    return { product: result.details, attribution: result.attribution };
  }

  public async getProductOffers(input: ProductOffersInput): Promise<ProductOffersOutput> {
    const result = await this.provider.getImmersiveProduct({
      pageToken: input.id,
      forceFresh: input.forceFresh ?? false,
    });
    const offers = result.offers.slice(0, this.clampResults(input.maxResults));
    return { id: input.id, offers, offerCount: offers.length, attribution: result.attribution };
  }

  public async compareOffers(input: CompareOffersInput): Promise<CompareOffersOutput> {
    const sortBy = input.sortBy ?? 'knownDeliveredSubtotal';
    const result = await this.provider.getImmersiveProduct({
      pageToken: input.id,
      forceFresh: input.forceFresh ?? false,
    });
    const comparable = result.offers.filter((offer) => sortKey(sortBy, offer) !== undefined);
    const sorted = [...comparable].sort((a, b) => {
      const left = sortKey(sortBy, a) as number;
      const right = sortKey(sortBy, b) as number;
      return sortBy === 'rating' ? right - left : left - right;
    });
    const distinctCurrencies = new Set(
      comparable.map((offer) => offer.price?.currency ?? UNKNOWN_CURRENCY),
    );
    const ranked = sorted.slice(0, this.clampResults(input.maxResults)).map((offer, index) => ({
      rank: index + 1,
      offer,
      deliveredSubtotalKnown: offer.knownDeliveredSubtotal !== undefined,
    }));
    return {
      id: input.id,
      sortBy,
      comparedOfferCount: comparable.length,
      mixedCurrencies: distinctCurrencies.size > 1,
      offers: ranked,
      attribution: result.attribution,
    };
  }

  public async findSimilarProducts(
    input: FindSimilarProductsInput,
  ): Promise<FindSimilarProductsOutput> {
    const result = await this.provider.getImmersiveProduct({
      pageToken: input.id,
      forceFresh: input.forceFresh ?? false,
    });
    const relatedProducts = result.relatedProducts.slice(0, this.clampResults(input.maxResults));
    return {
      id: input.id,
      relatedProducts,
      relatedProductCount: relatedProducts.length,
      attribution: result.attribution,
    };
  }
}
