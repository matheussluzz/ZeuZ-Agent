import type { ActivationError, RoutingReason } from './types.js';

export class SkillRegistryError extends Error {
  readonly code: string;
  readonly reasons: RoutingReason[];

  constructor(code: string, message: string, reasons: RoutingReason[] = []) {
    super(message);
    this.name = 'SkillRegistryError';
    this.code = code;
    this.reasons = reasons;
  }
}

export function activationError(input: {
  code: string;
  message: string;
  reasons: RoutingReason[];
  selection: string[];
  dependencies: string[];
  budgetBytes: number;
  consumedBytes: number;
}): ActivationError {
  const error = new SkillRegistryError(input.code, input.message, input.reasons) as ActivationError;
  error.selection = input.selection;
  error.dependencies = input.dependencies;
  error.budgetBytes = input.budgetBytes;
  error.consumedBytes = input.consumedBytes;
  return error;
}
