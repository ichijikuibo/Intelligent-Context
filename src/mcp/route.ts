/**
 * Streamable HTTP endpoint for the Intelligent Context MCP server.
 *
 * Mounted on the management API so it reuses the existing per-user API key
 * authentication (`Authorization: Bearer <key>` or `X-API-Key: <key>`) and the
 * live database connection. MCP clients are pointed at:
 *
 *   http://<management-host>:<management-port>/mcp
 *
 * The transport is **stateless**: a fresh `McpServer` + transport is created per
 * request, with the authenticated user captured in a closure. This keeps the
 * server horizontally simple and avoids per-session lifecycle bookkeeping. It
 * also means `GET`/`DELETE` (which exist for server-initiated SSE streams and
 * session teardown) are not supported — every request is a self-contained POST.
 */
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createIntelligentContextMcpServer } from './server';
import { attachAuthContext } from '../auth/context';
import { logger } from '../utils/logger';

const JSON_RPC_METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0' as const,
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
};

/**
 * Authenticate the caller and return the MCP router.
 *
 * The caller must present a valid per-user API key (or session). The same
 * `attachAuthContext` used by the rest of the management API resolves it, so
 * project membership and audit trails keep working unchanged.
 */
export function createMcpRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const user = await attachAuthContext(req);
    if (!user) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required. Provide a valid API key.' },
        id: null,
      });
      return;
    }

    // Stateless mode: a new server + transport per request.
    const server = createIntelligentContextMcpServer(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // `req.body` is already parsed by the management app's JSON middleware.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP request failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal MCP server error.' },
          id: null,
        });
      }
    }
  });

  // GET (server-initiated streams) and DELETE (session teardown) are not part of
  // a stateless deployment.
  router.get('/', (_req, res) => res.status(405).json(JSON_RPC_METHOD_NOT_ALLOWED));
  router.delete('/', (_req, res) => res.status(405).json(JSON_RPC_METHOD_NOT_ALLOWED));

  return router;
}
