import type { Application } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

interface TestServerContext {
  baseUrl: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function withTestServer(
  app: Application,
  run: (context: TestServerContext) => Promise<void>
): Promise<void> {
  const server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Unable to determine the test server address.');
  }

  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run({
      baseUrl,
      request: (path, init) => fetch(`${baseUrl}${path}`, init),
    });
  } finally {
    await closeServer(server);
  }
}