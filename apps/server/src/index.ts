import { startProductionServer, type StartedProductionServer } from './production';

let startedServer: StartedProductionServer | null = null;
let shutdownPromise: Promise<void> | null = null;

try {
  startedServer = await startProductionServer();
  console.log(`Richman server listening at http://127.0.0.1:${startedServer.port}`);
} catch (error) {
  console.error('Failed to start Richman server:', error);
  process.exitCode = 1;
}

process.once('SIGINT', () => {
  void shutdown().catch(reportShutdownFailure);
});
process.once('SIGTERM', () => {
  void shutdown().catch(reportShutdownFailure);
});

async function shutdown(): Promise<void> {
  if (shutdownPromise !== null) {
    await shutdownPromise;
    return;
  }

  shutdownPromise = closeStartedServer();
  await shutdownPromise;
}

async function closeStartedServer(): Promise<void> {
  if (startedServer !== null) {
    await startedServer.close();
  }
  process.exitCode = 0;
}

function reportShutdownFailure(error: unknown): void {
  console.error('Failed to stop Richman server:', error);
  process.exitCode = 1;
}
