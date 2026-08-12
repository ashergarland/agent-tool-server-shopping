import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

describe('configuration', () => {
  it('normalizes booleans and ignores blank optional values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      MUTATIONS_ENABLED: 'True',
      PUBLIC_BASE_URL: '',
    });
    expect(config.guardrails.mutationsEnabled).toBe(true);
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('rejects disabled production authentication', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })),
    ).toThrow(ConfigurationError);
  });

  it('requires strong API keys', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow('at least 32');
  });

  it('requires a SerpApi key in production', () => {
    expect(() =>
      buildConfig(
        envSchema.parse({
          NODE_ENV: 'production',
          AUTH_MODE: 'api-key',
          API_KEYS: '12345678901234567890123456789012',
        }),
      ),
    ).toThrow('SERPAPI_API_KEY');
  });

  it('rejects a default result count above the configured maximum', () => {
    expect(() =>
      buildConfig(
        envSchema.parse({
          NODE_ENV: 'test',
          AUTH_MODE: 'api-key',
          API_KEYS: '12345678901234567890123456789012',
          SHOPPING_DEFAULT_RESULTS: '50',
          SHOPPING_MAX_RESULTS: '10',
        }),
      ),
    ).toThrow('SHOPPING_DEFAULT_RESULTS');
  });

  it('populates shopping defaults', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      SERPAPI_API_KEY: 'test-serpapi-key',
    });
    expect(config.shopping.serpApi.apiKey).toBe('test-serpapi-key');
    expect(config.shopping.serpApi.baseUrl).toBe('https://serpapi.com');
    expect(config.shopping.defaultResults).toBeLessThanOrEqual(config.shopping.maxResults);
    expect(config.shopping.defaultCountry).toBe('us');
    expect(config.shopping.defaultLanguage).toBe('en');
  });
});
