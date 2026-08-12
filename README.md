# Agent Tool Server: Google Shopping (SerpApi)

A hosted, read-only agent tool server for Google Shopping. It exposes five product-research
tools backed by [SerpApi](https://serpapi.com/)'s `google_shopping` and
`google_immersive_product` engines through stdio MCP, stateless Streamable HTTP MCP, and
HTTP/OpenAPI, using the same typed tool registry for every transport.

## Tools

| Tool                             | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `shopping_search_products`       | Search Google Shopping for products matching a query and filters      |
| `shopping_get_product_details`   | Fetch normalized details for one product by its provider-supplied id  |
| `shopping_get_product_offers`    | List seller offers (price, shipping, condition) for one product       |
| `shopping_compare_offers`        | Rank a product's offers by price, rating, or known delivered subtotal |
| `shopping_find_similar_products` | List provider-supplied related/similar products for one product       |

All five tools are `read`-only: they never mutate state and never write to SerpApi. Every
response includes an `attribution` block (`provider`, `sourceUrl`, `retrievedAt`) so callers know
where data came from and how fresh it is.

### Design decisions worth knowing

- **No inferred data.** Currency, shipping cost, and availability are only reported when the
  provider states them explicitly. Nothing is guessed from price strings, symbols, or absence of
  a field.
- **`knownDeliveredSubtotal`, not "total".** An offer's price and shipping cost are summed only
  when both are known and share the same currency; the field is deliberately not named "total"
  because tax and other charges may be unknown. It is omitted otherwise.
- **Conservative filters.** `minPrice`/`maxPrice`/`minRating` in `shopping_search_products` and
  `sortBy` in `shopping_compare_offers` _exclude_ items with an unknown value for the filtered
  field rather than assuming they pass.
- **Freshness is caller-controlled.** Every tool accepts `forceFresh` (default `false`), which maps
  to SerpApi's `no_cache=true`. There is no application-level caching anywhere in this service.
- **No images in outputs.** Thumbnail/image URLs returned by SerpApi are never included in any
  tool output.
- **Related products are provider-supplied.** `shopping_find_similar_products` results are labeled
  `relationSource: "provider_supplied"` — they reflect SerpApi's own similarity ranking, not a
  ranking computed by this server.
- **Bounded result sizes.** `SHOPPING_DEFAULT_RESULTS` and `SHOPPING_MAX_RESULTS` bound how many
  products/offers a single call can return; requests are clamped, never rejected, for values in
  range.

## Included contract

| Method            | Path                | Authentication | Purpose                                 |
| ----------------- | ------------------- | -------------- | --------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness/readiness                      |
| `GET`             | `/version`          | Public         | Build and capability metadata           |
| `GET`             | `/openapi.json`     | Public         | OpenAPI 3.1 generated from the registry |
| `GET`             | `/tools`            | Required       | Tool catalogue and input/output schemas |
| `POST`            | `/tools/{toolName}` | Required       | Invoke one registered tool              |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP           |

`src/tools/definitions.ts` is the single source of truth. Zod schemas drive runtime input and
output validation, MCP registration, JSON Schema, OpenAPI operations, read/write annotations, and
mutation policy. Do not independently define transport-specific tool lists.

## Architecture

```text
HTTP / OpenAPI / MCP transports
             |
       ToolRegistry
             |
          Services (ShoppingService)
             |
       Provider port (ShoppingProvider)
             |
      Provider adapter (SerpApiProvider)
```

- Transports contain no provider or shopping-domain logic.
- `ShoppingService` implements conservative filtering, clamping, and sort behavior and only
  depends on the `ShoppingProvider` port — never on SerpApi's own SDK/response shapes.
- `SerpApiProvider` is the only module aware of SerpApi's JSON shapes. It performs safe
  normalization (never inferring currency/shipping/availability), timeout/retry handling, and
  maps upstream failures to `AppError`.
- The provider port intentionally exposes exactly two methods, `searchProducts` and
  `getImmersiveProduct`, mirroring the two permitted SerpApi engines. `shopping_get_product_details`,
  `shopping_get_product_offers`, and `shopping_find_similar_products` all call
  `getImmersiveProduct` once and read different parts of the same normalized result, avoiding
  redundant upstream calls.
- Every transport uses the same `ToolRegistry`.
- `Guardrails` (mutation-confirmation policy) is retained as generic reusable infrastructure for
  any future write tools; none of the five current tools use it since they are all read-only.

## Start locally

Node.js 22 is required.

```bash
npm ci
cp .env.example .env
# Add a real SerpApi key to .env (get one from https://serpapi.com/manage-api-key)
npm run dev
```

Disabled authentication is allowed only in development. For API-key mode, use a random key of at
least 32 characters:

```bash
API_KEY="$(openssl rand -hex 32)"
AUTH_MODE=api-key API_KEYS="$API_KEY" SERPAPI_API_KEY="<your-serpapi-key>" npm run dev
curl -H "x-api-key: $API_KEY" http://localhost:8080/tools
```

Call a tool over HTTP:

```bash
curl -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"query":"wireless mouse","maxResults":5}' \
  http://localhost:8080/tools/shopping_search_products
```

Build and run stdio MCP:

```bash
npm run build
npm run mcp:stdio
```

Generate the OpenAPI artifact:

```bash
npm run openapi:emit
```

## Security defaults

- Production refuses `AUTH_MODE=disabled`.
- Production refuses to start without `SERPAPI_API_KEY`, which is a secret kept separate from
  `API_KEYS` (the caller-facing tool-server credential).
- API keys are compared as fixed-width HMAC digests and only non-reversible fingerprints are
  logged.
- The SerpApi request URL is redacted (`api_key` stripped) before it is ever logged or used as an
  attribution `sourceUrl`.
- Authentication is rate-limited before and after credential verification.
- Request bodies are limited to 1 MB.
- Caller-provided request IDs are bounded; generated IDs are returned on every response.
- Logger redaction covers authorization and API-key headers.
- Production masks unhandled 5xx details.
- Inputs and outputs are validated at the registry boundary.
- All five tools are read-only; mutation guardrails remain available for future write tools but
  default off (`MUTATIONS_ENABLED=false`).
- The runtime container executes as the unprivileged Node user.
- Stateless MCP creates no server-side session store.
- There is no application-level cache: every call reaches SerpApi (subject to its own caching
  unless `forceFresh: true`/`no_cache=true` is requested).

The in-process rate limiter is appropriate for scale-to-zero instances but is not a globally
consistent quota. Put a distributed gateway in front of the service if callers require a
cross-replica quota.

## Reliability

- SerpApi calls use a per-attempt timeout (`SERPAPI_TIMEOUT_MS`) enforced with `AbortController`.
- Transient failures (network errors, HTTP 429, HTTP 5xx) are retried with exponential backoff up
  to `SERPAPI_MAX_RETRIES` times before surfacing an error.
- Provider errors are mapped to `AppError`: `not_found` for "no results" responses, `rate_limited`
  for HTTP 429, and `upstream_error` otherwise (retryable only when the failure was transient).

## Configuration

See `.env.example`. Production requires `AUTH_MODE=api-key` with `API_KEYS`, and a non-empty
`SERPAPI_API_KEY`. Multiple `API_KEYS` are comma-separated to support rotation.
`SHOPPING_DEFAULT_RESULTS` must not exceed `SHOPPING_MAX_RESULTS`. Keep `MUTATIONS_ENABLED=false`
until write tools and provider roles have been reviewed.

## Deployment

The Azure Container Apps example uses a user-assigned managed identity, Azure Container Registry,
Key Vault references (one secret for `API_KEYS`, a **separate** secret for `SERPAPI_API_KEY`), Log
Analytics, Application Insights, scale-to-zero, HTTP scaling, and health probes. Follow
[`docs/deployment.md`](docs/deployment.md); the bootstrap performs a safe two-pass deployment so no
application starts before its Key Vault secrets exist.

## Metadata

- `server.json` is the MCP registry metadata for this server.
- `examples/central-registry-entry.json` demonstrates the family registry entry.
- `npm run metadata:validate` validates both local examples.

Check the current upstream registry schema before publishing because external registry contracts
can evolve.

## Testing

- `tests/unit/shopping.test.ts` exercises `ShoppingService` against a deterministic
  `FakeShoppingProvider` (`tests/helpers/fake-provider.ts`) — no network access.
- `tests/unit/serpapi.test.ts` exercises `SerpApiProvider` against a mocked `fetch`, covering
  normalization, currency safety, `knownDeliveredSubtotal`, retries, timeouts, and error mapping.
- `tests/integration/live-serpapi.test.ts` is an **optional, disabled-by-default** live test
  against the real SerpApi service. Enable it only when you have a real key and are willing to
  spend SerpApi credits:

  ```bash
  RUN_LIVE_SERPAPI_TESTS=true SERPAPI_API_KEY=... npx vitest run tests/integration/live-serpapi.test.ts
  ```

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
docker build -t agent-tool-server-shopping .
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
```

CI additionally smoke-tests the container, compiles every Bicep entry point, audits production
dependencies, scans for secrets, and runs CodeQL.

## License

MIT
