import type { AppConfig } from '../config/index.js';
import type { ShoppingProvider } from '../provider/types.js';
import { Guardrails } from './guardrails.js';
import { ShoppingService } from './shopping.js';

export interface Services {
  readonly shopping: ShoppingService;
  readonly guardrails: Guardrails;
}

export const createServices = (config: AppConfig, provider: ShoppingProvider): Services => {
  const guardrails = new Guardrails(config);
  return { guardrails, shopping: new ShoppingService(provider, config) };
};
