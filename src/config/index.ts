import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const booleanish = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  context.addIssue({ code: 'custom', message: 'Expected a boolean value' });
  return z.NEVER;
});

export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-shopping'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_MODE: z.enum(['api-key', 'disabled']).default('api-key'),
  API_KEYS: csv.default([]),
  MUTATIONS_ENABLED: booleanish.default(false),
  MUTATION_CONFIRMATION_REQUIRED: booleanish.default(true),
  SERPAPI_API_KEY: z.string().default(''),
  SERPAPI_BASE_URL: z.url().default('https://serpapi.com'),
  SERPAPI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(8_000),
  SERPAPI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  SERPAPI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(5_000).default(250),
  SHOPPING_DEFAULT_RESULTS: z.coerce.number().int().min(1).max(100).default(10),
  SHOPPING_MAX_RESULTS: z.coerce.number().int().min(1).max(100).default(40),
  SHOPPING_DEFAULT_COUNTRY: z.string().min(2).max(10).default('us'),
  SHOPPING_DEFAULT_LANGUAGE: z.string().min(2).max(10).default('en'),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
  readonly guardrails: {
    readonly mutationsEnabled: boolean;
    readonly confirmationRequired: boolean;
  };
  readonly shopping: {
    readonly serpApi: {
      readonly apiKey: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxRetries: number;
      readonly retryBaseDelayMs: number;
    };
    readonly defaultResults: number;
    readonly maxResults: number;
    readonly defaultCountry: string;
    readonly defaultLanguage: string;
  };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

export const buildConfig = (env: Env): AppConfig => {
  if (env.AUTH_MODE === 'disabled' && env.NODE_ENV === 'production') {
    throw new ConfigurationError('AUTH_MODE=disabled is not permitted in production');
  }
  if (env.AUTH_MODE === 'api-key') {
    if (env.API_KEYS.length === 0) {
      throw new ConfigurationError('AUTH_MODE=api-key requires API_KEYS');
    }
    if (env.API_KEYS.some((key) => key.length < 32)) {
      throw new ConfigurationError('Every API key must be at least 32 characters');
    }
  }
  if (env.NODE_ENV === 'production' && env.SERPAPI_API_KEY.length === 0) {
    throw new ConfigurationError('SERPAPI_API_KEY is required in production');
  }
  if (env.SHOPPING_DEFAULT_RESULTS > env.SHOPPING_MAX_RESULTS) {
    throw new ConfigurationError('SHOPPING_DEFAULT_RESULTS must not exceed SHOPPING_MAX_RESULTS');
  }
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    service: {
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      gitSha: env.GIT_SHA,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    },
    logLevel: env.LOG_LEVEL,
    auth:
      env.AUTH_MODE === 'disabled'
        ? { mode: 'disabled' }
        : { mode: 'api-key', apiKeys: env.API_KEYS },
    guardrails: {
      mutationsEnabled: env.MUTATIONS_ENABLED,
      confirmationRequired: env.MUTATION_CONFIRMATION_REQUIRED,
    },
    shopping: {
      serpApi: {
        apiKey: env.SERPAPI_API_KEY,
        baseUrl: env.SERPAPI_BASE_URL,
        timeoutMs: env.SERPAPI_TIMEOUT_MS,
        maxRetries: env.SERPAPI_MAX_RETRIES,
        retryBaseDelayMs: env.SERPAPI_RETRY_BASE_DELAY_MS,
      },
      defaultResults: env.SHOPPING_DEFAULT_RESULTS,
      maxResults: env.SHOPPING_MAX_RESULTS,
      defaultCountry: env.SHOPPING_DEFAULT_COUNTRY,
      defaultLanguage: env.SHOPPING_DEFAULT_LANGUAGE,
    },
  };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data);
};
