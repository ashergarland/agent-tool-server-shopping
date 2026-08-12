import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import { SerpApiProvider } from './provider/serpapi.js';
import type { ShoppingProvider } from './provider/types.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly provider?: ShoppingProvider;
}

export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const provider = options.provider ?? SerpApiProvider.fromConfig(config, logger);
  const services = createServices(config, provider);
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry });
  return { config, logger, services, registry, http };
};
