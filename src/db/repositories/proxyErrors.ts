import { v4 as uuidv4 } from 'uuid';
import { db, markDirty, execute } from '../connection';
import { getSchema, type NewProxyErrorEntry, type ProxyErrorEntry } from '../schema';

function tables() {
  return getSchema();
}

export interface InsertProxyErrorData {
  projectId?: string | null;
  sessionId?: string;
  requestId?: string;
  model: string;
  providerName: string;
  providerType: string;
  url: string;
  statusCode?: number | null;
  errorMessage: string;
  errorType: 'http_error' | 'exception';
  requestHeaders: Record<string, unknown>;
  requestBody: string;
  responseHeaders?: Record<string, unknown>;
  responseBody?: string;
}

export const proxyErrorsRepo = {
  async insert(data: InsertProxyErrorData): Promise<ProxyErrorEntry> {
    const { proxyErrors } = tables();
    const row = {
      id: uuidv4(),
      projectId: data.projectId ?? null,
      sessionId: data.sessionId ?? null,
      requestId: data.requestId ?? null,
      model: data.model,
      providerName: data.providerName,
      providerType: data.providerType,
      url: data.url,
      statusCode: data.statusCode ?? null,
      errorMessage: data.errorMessage,
      errorType: data.errorType,
      requestHeaders: JSON.stringify(data.requestHeaders),
      requestBody: data.requestBody,
      responseHeaders: JSON.stringify(data.responseHeaders ?? {}),
      responseBody: data.responseBody ?? '',
      createdAt: new Date(),
    } as NewProxyErrorEntry;
    await execute(db().insert(proxyErrors).values(row));
    markDirty();
    return row as unknown as ProxyErrorEntry;
  },
};
