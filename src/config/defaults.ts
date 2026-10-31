import type { AppConfig } from './config';

export const DEFAULT_CONFIG: AppConfig = {
  mode: 'local',
  proxy: {
    host: '127.0.0.1',
    port: 1234,
    rateLimitPerMinute: 600,
  },
  management: {
    host: '127.0.0.1',
    port: 9090,
  },
  database: {
    type: 'sqlite',
    sqlitePath: '~/.intelligent-context/data/db.sqlite',
    backupRetention: 10,
  },
  models: {
    contextSelector: '',
    summarizer: '',
    analyzer: '',
    icTools: '',
  },
  providers: {},
  context: {
    tokenBudget: 4000,
    autoSummarizeThreshold: 10,
    fallbackExtraction: true,
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    maxCandidates: 50,
    minConfidence: 0.3,
    semanticDuplicateThreshold: 0.92,
    debugLearningBlocks: false,
    bypassSelectorItemThreshold: 10,
    bypassSelectorTokenThreshold: 2000,
    contextReplayTtlMinutes: 30,
    maxCachedContexts: 200,
    reservedResponseTokens: 4000,
    contextOverheadTokens: 500,
    defaultModelMaxTokens: 16000,
    gathererSkipOnToolContinuation: true,
    maxRecordLearnings: 200,
  },
  workers: {
    summarizeIntervalMinutes: 5,
    analyzeIntervalHours: 24,
    idleThresholdMinutes: 30,
  },
  logging: {
    level: 'info',
  },
};
