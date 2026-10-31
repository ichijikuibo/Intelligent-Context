export type QueryKind = 'select' | 'insert' | 'update' | 'delete';

export interface QueryRecord {
  kind: QueryKind;
  table?: unknown;
  values?: unknown;
  set?: unknown;
  where?: unknown;
  orderBy?: unknown[];
}

interface MockQueryChain {
  from: (table: unknown) => MockQueryChain;
  innerJoin: (table: unknown, on: unknown) => MockQueryChain;
  where: (clause: unknown) => MockQueryChain;
  orderBy: (...clauses: unknown[]) => MockQueryChain;
  values: (payload: unknown) => MockQueryChain;
  set: (payload: unknown) => MockQueryChain;
  all: () => never;
  get: () => never;
  run: () => void;
}

function createColumn(tableName: string, columnName: string): { table: string; column: string } {
  return { table: tableName, column: columnName };
}

function createTable<TColumns extends readonly string[]>(tableName: string, columns: TColumns): Record<TColumns[number], unknown> {
  return columns.reduce<Record<string, unknown>>((acc, columnName) => {
    acc[columnName] = createColumn(tableName, columnName);
    return acc;
  }, {});
}

export function createSchemaTables() {
  return {
    projects: createTable('projects', [
      'id',
      'name',
      'rootPath',
      'pathPattern',
      'isDefault',
      'settings',
      'createdAt',
      'updatedAt',
      'summarizationLastRun',
      'analyzerLastRun',
    ] as const),
    users: createTable('users', [
      'id',
      'email',
      'passwordHash',
      'role',
      'isApproved',
      'isDisabled',
      'accessAllProjects',
      'accessAllModels',
      'allowedModels',
      'hiddenModels',
      'createdAt',
      'lastLoginAt',
    ] as const),
    userApiKeys: createTable('userApiKeys', [
      'id',
      'userId',
      'keyHash',
      'name',
      'createdAt',
      'lastUsedAt',
      'revokedAt',
    ] as const),
    projectMembers: createTable('projectMembers', ['projectId', 'userId', 'role', 'createdAt'] as const),
    providerConfigs: createTable('providerConfigs', [
      'id',
      'name',
      'type',
      'baseUrl',
      'apiKey',
      'models',
      'isEnabled',
      'isDefault',
      'createdAt',
      'updatedAt',
    ] as const),
    providerModelMetadata: createTable('providerModelMetadata', [
      'providerId',
      'modelId',
      'contextLength',
      'displayName',
      'apiFormat',
      'updatedAt',
    ] as const),
    providerModelOverrides: createTable('providerModelOverrides', [
      'providerId',
      'modelId',
      'displayName',
      'contextLength',
      'apiFormat',
      'supportsReasoning',
      'supportsVision',
      'createdAt',
      'updatedAt',
    ] as const),
    modelReference: createTable('modelReference', [
      'source',
      'modelId',
      'vendor',
      'displayName',
      'contextLength',
      'maxOutputTokens',
      'supportsVision',
      'supportsReasoning',
      'updatedAt',
    ] as const),
    summaries: createTable('summaries', [
      'id',
      'projectId',
      'title',
      'content',
      'oneLineSummary',
      'categoriesList',
      'sourceChunkIds',
      'version',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ] as const),
    analysisFindings: createTable('analysisFindings', [
      'id',
      'projectId',
      'type',
      'severity',
      'title',
      'description',
      'relatedChunkIds',
      'actions',
      'status',
      'createdAt',
      'reviewedAt',
      'actionsAppliedAt',
    ] as const),
    learningChunks: createTable('learningChunks', [
      'id',
      'projectId',
      'sessionId',
      'requestId',
      'fact',
      'category',
      'confidence',
      'source',
      'hash',
      'tokensUsed',
      'summarized',
      'createdAt',
      'deletedAt',
    ] as const),
    learningFiles: createTable('learningFiles', [
      'id',
      'chunkId',
      'fileName',
      'purpose',
      'createdAt',
      'deletedAt',
    ] as const),
    learningFileIndex: createTable('learningFileIndex', [
      'id',
      'projectId',
      'fileName',
      'normalizedFileName',
      'summary',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ] as const),
    learningFileChunks: createTable('learningFileChunks', [
      'fileId',
      'chunkId',
      'createdAt',
    ] as const),
    learningFileSummaries: createTable('learningFileSummaries', [
      'fileId',
      'summaryId',
      'createdAt',
    ] as const),
    learningCodeExtracts: createTable('learningCodeExtracts', [
      'id',
      'chunkId',
      'fileName',
      'language',
      'symbolsJson',
      'code',
      'createdAt',
      'deletedAt',
    ] as const),
    categories: createTable('categories', [
      'id',
      'projectId',
      'parentId',
      'name',
      'slug',
      'description',
      'color',
    ] as const),
    chunkCategories: createTable('chunkCategories', [
      'chunkId',
      'categoryId',
      'assignedBy',
      'confidence',
    ] as const),
    chunkEmbeddings: createTable('chunkEmbeddings', [
      'id',
      'chunkId',
      'vector',
      'model',
      'dimensions',
      'createdAt',
    ] as const),
  };
}

function createQueryChain(record: QueryRecord): MockQueryChain {
  const chain: MockQueryChain = {
    from(table) {
      record.table = table;
      return chain;
    },
    innerJoin(table, on) {
      return chain;
    },
    where(clause) {
      record.where = clause;
      return chain;
    },
    orderBy(...clauses) {
      record.orderBy = clauses;
      return chain;
    },
    values(payload) {
      record.values = payload;
      return chain;
    },
    set(payload) {
      record.set = payload;
      return chain;
    },
    all() {
      throw new Error('Mock query .all() should not be called directly in repository tests.');
    },
    get() {
      throw new Error('Mock query .get() should not be called directly in repository tests.');
    },
    run() {},
  };

  return chain;
}

export function createMockDbHarness() {
  const records: QueryRecord[] = [];

  return {
    records,
    api: {
      select(): MockQueryChain {
        const record: QueryRecord = { kind: 'select' };
        records.push(record);
        return createQueryChain(record);
      },
      insert(table: unknown): MockQueryChain {
        const record: QueryRecord = { kind: 'insert', table };
        records.push(record);
        return createQueryChain(record);
      },
      update(table: unknown): MockQueryChain {
        const record: QueryRecord = { kind: 'update', table };
        records.push(record);
        return createQueryChain(record);
      },
      delete(table: unknown): MockQueryChain {
        const record: QueryRecord = { kind: 'delete', table };
        records.push(record);
        return createQueryChain(record);
      },
    },
    lastRecord(kind: QueryKind): QueryRecord | undefined {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.kind === kind) {
          return records[index];
        }
      }

      return undefined;
    },
  };
}