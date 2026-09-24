import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRoomServer, type RunningRoomServer } from './server';
import { RoomManager } from './rooms/roomManager';
import { createRoomSnapshotStore } from './rooms/roomSnapshotStore';
import type { RoomDomainEvent } from './rooms/roomTypes';

export interface StartedProductionServer {
  port: number;
  close(): Promise<void>;
}

type ProductionRoomServer = RunningRoomServer<NodeJS.Timeout>;
type RandomInt = (min: number, max: number) => number;

const DEFAULT_PORT = 3000;
const TOKEN_BYTE_LENGTH = 32;
const ROOM_CODE_COUNT = 1_000_000;
const MIN_AUTOMATION_DELAY_MS = 800;
const MAX_AUTOMATION_DELAY_MS = 1600;
const CLIENT_DIST_PATH = fileURLToPath(new URL('../../client/dist', import.meta.url));
/** 房间快照目录（C-③）：默认放在 server 包内的 `.runtime/`，可用环境变量覆盖。 */
const DEFAULT_SNAPSHOT_DIR = fileURLToPath(new URL('../.runtime/room-snapshots', import.meta.url));

export async function startProductionServer(
  requestedPort = Number(process.env.PORT ?? DEFAULT_PORT),
): Promise<StartedProductionServer> {
  const server = createRoomServer<NodeJS.Timeout>({
    clientDistPath: CLIENT_DIST_PATH,
    roomManagerFactory: (onAsyncEvents) => createProductionRoomManager(onAsyncEvents),
  });

  try {
    const port = await listen(server, requestedPort);
    return {
      port,
      close: server.close,
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export function generateProductionGameSeed(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
}

export function nextProductionAutomationDelayMs(randomInteger: RandomInt = randomInt): number {
  return randomInteger(MIN_AUTOMATION_DELAY_MS, MAX_AUTOMATION_DELAY_MS + 1);
}

function createProductionRoomManager(
  onAsyncEvents: (events: RoomDomainEvent[]) => void,
): RoomManager<NodeJS.Timeout> {
  const snapshotDirectory = process.env.RICHMAN_SNAPSHOT_DIR ?? DEFAULT_SNAPSHOT_DIR;
  return new RoomManager<NodeJS.Timeout>({
    generatePlayerId: randomUUID,
    generateToken: generateProductionGameSeed,
    nextRoomNumber: () => randomInt(ROOM_CODE_COUNT),
    compareTokens,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle),
    onAsyncEvents,
    generateGameSeed: generateProductionGameSeed,
    nextAutomationDelayMs: nextProductionAutomationDelayMs,
    // C-③：房间状态变更即落盘，进程重启后（pm2 restart / 部署）进行中的对局可恢复。
    snapshotStore: createRoomSnapshotStore({ directory: snapshotDirectory }),
    onServerError: (message, error) => console.error(message, error),
  });
}

function compareTokens(actual: string, supplied: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');

  if (actualBuffer.byteLength !== suppliedBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(actualBuffer, suppliedBuffer);
}

async function listen(server: ProductionRoomServer, requestedPort: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.httpServer.off('error', onError);
      resolve();
    };

    server.httpServer.once('error', onError);
    server.httpServer.once('listening', onListening);
    server.httpServer.listen(requestedPort, '0.0.0.0');
  });

  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Production server did not bind to a TCP port.');
  }

  return address.port;
}
