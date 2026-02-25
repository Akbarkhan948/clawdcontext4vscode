/**
 * @module ai
 * Barrel export for AI capabilities.
 */

export {
  aiComplete,
  testAiConnection,
  isAiEnabled,
  getAiConfig,
} from './provider';

export type {
  AiProvider,
  AiMessage,
  AiCompletionOptions,
  AiCompletionResult,
  AiConfig,
} from './provider';

export {
  aiTestConnection,
  aiReviewConfig,
  aiExplainDiagnostic,
  aiSuggestRefactor,
  aiSecurityReview,
} from './commands';
