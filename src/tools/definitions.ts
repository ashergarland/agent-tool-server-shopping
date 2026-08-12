import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

// Provider-neutral shapes mirrored from src/provider/types.ts. Keep these in sync with that file;
// they exist here (rather than being generated from it) so the wire contract is explicit and
// reviewable independent of the provider implementation.

const moneySchema = z.object({
  amount: z.number(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 code')
    .optional(),
});

const attributionSchema = z.object({
  provider: z.string(),
  retrievedAt: z.string(),
  sourceUrl: z.string().optional(),
});

const productSummarySchema = z.object({
  id: z.string(),
  detailsAvailable: z.boolean(),
  title: z.string(),
  seller: z.string().optional(),
  productUrl: z.string().optional(),
  price: moneySchema.optional(),
  rating: z.number().optional(),
  reviewsCount: z.number().optional(),
  condition: z.string().optional(),
  extensions: z.array(z.string()).readonly().optional(),
});

const productDetailsSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  seller: z.string().optional(),
  price: moneySchema.optional(),
  rating: z.number().optional(),
  reviewsCount: z.number().optional(),
  condition: z.string().optional(),
  extensions: z.array(z.string()).readonly().optional(),
});

const offerSchema = z.object({
  sellerName: z.string(),
  link: z.string().optional(),
  price: moneySchema.optional(),
  shippingPrice: moneySchema.optional(),
  knownDeliveredSubtotal: moneySchema.optional(),
  condition: z.string().optional(),
  rating: z.number().optional(),
  reviewsCount: z.number().optional(),
  returnPolicy: z.string().optional(),
});

const relatedProductSchema = z.object({
  id: z.string(),
  detailsAvailable: z.boolean(),
  title: z.string(),
  seller: z.string().optional(),
  price: moneySchema.optional(),
  rating: z.number().optional(),
  reviewsCount: z.number().optional(),
  relationSource: z.literal('provider_supplied'),
});

const rankedOfferSchema = z.object({
  rank: z.number().int().positive(),
  offer: offerSchema,
  deliveredSubtotalKnown: z.boolean(),
});

const idInputShape = {
  id: z
    .string()
    .min(1)
    .max(2_000)
    .describe(
      'Provider-supplied identifier from a prior shopping_search_products or ' +
        'shopping_find_similar_products result (the `id` field of a product).',
    ),
  forceFresh: z
    .boolean()
    .default(false)
    .describe(
      'When true, bypasses any upstream provider cache and forces a live lookup. ' +
        'This server never caches results itself.',
    ),
};

const maxResultsField = (max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(
      `Maximum number of results to return. Defaults to a bounded deployment setting and is ` +
        `always capped at ${max}.`,
    );

export const searchProductsTool = defineTool({
  name: 'shopping_search_products',
  title: 'Search shopping products',
  summary: 'Search Google Shopping for products matching a free-text query.',
  description:
    'Read-only search backed by the SerpApi google_shopping engine. Applies conservative ' +
    'post-filters: a numeric filter (minPrice, maxPrice, minRating) excludes any product for ' +
    'which the corresponding value is unknown, rather than assuming it passes. Prices and ' +
    'ratings are never inferred or estimated; currency is only set when the provider explicitly ' +
    'states one. No images are returned. Every response includes attribution and a retrieval ' +
    'timestamp; set forceFresh=true to bypass the upstream cache.',
  kind: 'read',
  inputSchema: z.object({
    query: z.string().min(1).max(200).describe('Free-text shopping search query.'),
    maxResults: maxResultsField(100),
    countryCode: z
      .string()
      .min(2)
      .max(10)
      .optional()
      .describe(
        'Two-letter country code (Google `gl` parameter). Defaults to a deployment setting.',
      ),
    languageCode: z
      .string()
      .min(2)
      .max(10)
      .optional()
      .describe('Language code (Google `hl` parameter). Defaults to a deployment setting.'),
    minPrice: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Minimum price filter. Products with an unknown price are excluded, not assumed to pass.',
      ),
    maxPrice: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Maximum price filter. Products with an unknown price are excluded, not assumed to pass.',
      ),
    minRating: z
      .number()
      .min(0)
      .max(5)
      .optional()
      .describe(
        'Minimum rating filter. Products with an unknown rating are excluded, not assumed to pass.',
      ),
    forceFresh: z.boolean().default(false).describe('Bypass the upstream provider cache.'),
  }),
  outputSchema: z.object({
    query: z.string(),
    products: z.array(productSummarySchema).readonly(),
    resultCount: z.number().int(),
    attribution: attributionSchema,
  }),
  handler: (input, services) => services.shopping.searchProducts(input),
});

export const getProductDetailsTool = defineTool({
  name: 'shopping_get_product_details',
  title: 'Get product details',
  summary: 'Get detailed information for one product.',
  description:
    'Read-only lookup backed by the SerpApi google_immersive_product engine. Requires an `id` ' +
    'from shopping_search_products or shopping_find_similar_products; not every listing supports ' +
    'this lookup. No images are returned. Response includes attribution and a retrieval ' +
    'timestamp; set forceFresh=true to bypass the upstream cache.',
  kind: 'read',
  inputSchema: z.object(idInputShape),
  outputSchema: z.object({ product: productDetailsSchema, attribution: attributionSchema }),
  handler: (input, services) => services.shopping.getProductDetails(input),
});

export const getProductOffersTool = defineTool({
  name: 'shopping_get_product_offers',
  title: 'Get product offers',
  summary: 'List seller offers for one product.',
  description:
    'Read-only lookup backed by the SerpApi google_immersive_product engine. Each offer ' +
    'includes `shippingPrice` and `knownDeliveredSubtotal` only when the provider explicitly ' +
    'stated a shipping cost; a missing shipping price is never treated as free shipping. ' +
    '`knownDeliveredSubtotal` is price + shipping only when both are known in a compatible ' +
    'currency, avoiding the ambiguous term "total" since tax may still be unknown.',
  kind: 'read',
  inputSchema: z.object({ ...idInputShape, maxResults: maxResultsField(100) }),
  outputSchema: z.object({
    id: z.string(),
    offers: z.array(offerSchema).readonly(),
    offerCount: z.number().int(),
    attribution: attributionSchema,
  }),
  handler: (input, services) => services.shopping.getProductOffers(input),
});

export const compareOffersTool = defineTool({
  name: 'shopping_compare_offers',
  title: 'Compare product offers',
  summary: 'Rank seller offers for one product by price, delivered subtotal, or rating.',
  description:
    'Read-only comparison backed by the same data as shopping_get_product_offers. Offers are ' +
    'only ranked when the sort field is explicitly known for that offer; offers missing the ' +
    'sort field are excluded from the ranking rather than assumed. `knownDeliveredSubtotal` ' +
    '(price + shipping) is used by default and is only present when both are known in a ' +
    'compatible currency; it deliberately avoids the ambiguous term "total" since tax may still ' +
    'be unknown. `mixedCurrencies` is true when compared offers use more than one currency, in ' +
    'which case the numeric ranking should be treated with caution.',
  kind: 'read',
  inputSchema: z.object({
    ...idInputShape,
    maxResults: maxResultsField(100),
    sortBy: z
      .enum(['knownDeliveredSubtotal', 'price', 'rating'])
      .optional()
      .describe('Field to sort by. Defaults to knownDeliveredSubtotal.'),
  }),
  outputSchema: z.object({
    id: z.string(),
    sortBy: z.enum(['knownDeliveredSubtotal', 'price', 'rating']),
    comparedOfferCount: z.number().int(),
    mixedCurrencies: z.boolean(),
    offers: z.array(rankedOfferSchema).readonly(),
    attribution: attributionSchema,
  }),
  handler: (input, services) => services.shopping.compareOffers(input),
});

export const findSimilarProductsTool = defineTool({
  name: 'shopping_find_similar_products',
  title: 'Find similar products',
  summary: 'List products the provider considers related to one product.',
  description:
    'Read-only lookup backed by the SerpApi google_immersive_product engine. Every result has ' +
    '`relationSource: "provider_supplied"` because similarity is determined by the upstream ' +
    'provider, not computed by this server. No images are returned.',
  kind: 'read',
  inputSchema: z.object({ ...idInputShape, maxResults: maxResultsField(100) }),
  outputSchema: z.object({
    id: z.string(),
    relatedProducts: z.array(relatedProductSchema).readonly(),
    relatedProductCount: z.number().int(),
    attribution: attributionSchema,
  }),
  handler: (input, services) => services.shopping.findSimilarProducts(input),
});

export const toolDefinitions = [
  searchProductsTool,
  getProductDetailsTool,
  getProductOffersTool,
  compareOffersTool,
  findSimilarProductsTool,
] as const satisfies readonly ToolDefinition[];
