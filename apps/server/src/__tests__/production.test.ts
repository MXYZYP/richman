import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import { nextProductionAutomationDelayMs, startProductionServer } from '../production';
import { fetchProductionClient } from '../../../../scripts/smoke-production';

type BootstrappedProductionServer = {
  port: number;
  close: () => Promise<void>;
};

type TestPromiseResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

let activeServer: BootstrappedProductionServer | undefined;
const activeSockets: Socket[] = [];
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenLike = /^[0-9a-f]{64}$/;

afterEach(async () => {
  for (const socket of activeSockets.splice(0)) {
    socket.disconnect();
  }

  if (activeServer) {
    await activeServer.close();
    activeServer = undefined;
  }
});

describe('production room server bootstrap', () => {
  it('starts on an ephemeral port, creates a public room over WebSocket, and closes idempotently', async () => {
    activeServer = await startProductionServer(0);
    expect(activeServer.port).toBeGreaterThan(0);

    const socket = io(`http://127.0.0.1:${activeServer.port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
    });
    activeSockets.push(socket);

    const connectResolvers = (
      Promise as PromiseConstructor & { withResolvers<T>(): TestPromiseResolvers<T> }
    ).withResolvers<void>();
    socket.once('connect', connectResolvers.resolve);
    socket.once('connect_error', connectResolvers.reject);
    socket.connect();
    await connectResolvers.promise;

    const createResolvers = (
      Promise as PromiseConstructor & { withResolvers<T>(): TestPromiseResolvers<T> }
    ).withResolvers<unknown>();
    socket.emit('room:create', { mapId: 'china-tour', nickname: '主机', requestId: '00112233445566778899aabbccddeeff' }, createResolvers.resolve);
    const ack = createResolvers.promise;

    await expect(ack).resolves.toMatchObject({
      ok: true,
      room: {
        status: 'lobby',
        players: [{ nickname: '主机', isBot: false, online: true }],
      },
    });

    const createAck = await ack;
    if (!isRecord(createAck) || !isRecord(createAck.room)) {
      throw new Error('room:create ack must include a public room object');
    }

    expect(createAck.roomCode).toMatch(/^\d{6}$/);
    expect(createAck.playerId).toEqual(expect.stringMatching(uuidLike));
    expect(createAck.token).toEqual(expect.stringMatching(tokenLike));
    expect(createAck.playerId).not.toBe(createAck.token);
    expect(createAck.room.roomCode).toBe(createAck.roomCode);
    expect(createAck.room.hostId).toBe(createAck.playerId);
    expect(JSON.stringify(createAck.room)).not.toMatch(/"token"\s*:/);
    expect(JSON.stringify(createAck.room)).not.toContain(String(createAck.token));

    const disconnectResolvers = (
      Promise as PromiseConstructor & { withResolvers<T>(): TestPromiseResolvers<T> }
    ).withResolvers<void>();
    socket.once('disconnect', () => disconnectResolvers.resolve());
    await activeServer.close();
    await disconnectResolvers.promise;
    expect(socket.connected).toBe(false);
    await expect(activeServer.close()).resolves.toBeUndefined();
    activeServer = undefined;
  });
});

describe('production automation delay', () => {
  it('returns an integer within the inclusive automation delay bounds', () => {
    for (let call = 0; call < 2_000; call += 1) {
      const delayMs = nextProductionAutomationDelayMs();
      expect(Number.isInteger(delayMs)).toBe(true);
      expect(delayMs).toBeGreaterThanOrEqual(800);
      expect(delayMs).toBeLessThanOrEqual(1_600);
    }
  });

  it('uses exclusive randomInt bounds that include the maximum production delay', () => {
    let receivedBounds: [number, number] | undefined;
    const fakeRandomInt = (min: number, max: number): number => {
      receivedBounds = [min, max];
      return 1_600;
    };

    const delayMs = nextProductionAutomationDelayMs(fakeRandomInt);

    expect(receivedBounds).toEqual([800, 1_601]);
    expect(delayMs).toBe(1_600);
  });
});

describe('production smoke client fetch', () => {
  it('supplies an abort signal when fetching the production client', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return new Response('<!DOCTYPE html>', { status: 200 });
    };

    await fetchProductionClient('http://127.0.0.1:1234/', fakeFetch, 10);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it('clears the fetch timeout after a successful production client response', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      receivedSignal = init?.signal;
      return new Response('<!DOCTYPE html>', { status: 200 });
    };

    await fetchProductionClient('http://127.0.0.1:1234/', fakeFetch, 10);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);

    await delay(30);

    expect(receivedSignal?.aborted).toBe(false);
  });

  it('rejects a successful response that is not an HTML document', async () => {
    const fakeFetch: typeof fetch = async () => new Response('not HTML', { status: 200 });

    await expect(fetchProductionClient('http://127.0.0.1:1234/', fakeFetch, 10)).rejects.toThrow();
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
