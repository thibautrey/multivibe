import Schema from '@deepseek-ai/schemastery';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createCompanion } from './companion.mjs';
import { registerCompanion } from './routes.mjs';

export const name = 'dsh-multivibe';
export const inject = ['credentials', 'connection', 'tools', 'llm', 'settings'];
export const Config = Schema.object({});

export function apply(ctx) {
  registerCompanion(ctx, createCompanion(ctx, { stateKey: credentialKey(name, 'connection') }), defineTool);
}
