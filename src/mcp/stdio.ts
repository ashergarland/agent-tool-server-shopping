import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { SerpApiProvider } from '../provider/serpapi.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createLogger } from '../util/logger.js';
import { createMcpServer } from './server.js';

const config = loadConfig({ ...process.env, AUTH_MODE: 'disabled', NODE_ENV: 'development' });
const logger = createLogger(config);
const server = createMcpServer(
  config,
  createToolRegistry(),
  createServices(config, SerpApiProvider.fromConfig(config, logger)),
  {
    requestId: `stdio-${process.pid}`,
    principal: 'stdio-client',
  },
);

await server.connect(new StdioServerTransport());
