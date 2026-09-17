import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';
import { getPartyAddresses } from '../apps/server/src/party/networkAddress';
import { startProductionServer, type StartedProductionServer } from '../apps/server/src/production';

let startedServer: StartedProductionServer | null = null;
let shutdownPromise: Promise<void> | null = null;

void start();

async function start(): Promise<void> {
  try {
    startedServer = await startProductionServer();
    const addresses = getPartyAddresses(networkInterfaces(), startedServer.port);

    console.log(`本机访问：${addresses.localUrl}`);
    if (addresses.lanUrl === null) {
      console.warn('未检测到局域网 IPv4；请确认电脑已连接 Wi-Fi。');
    } else {
      console.log(`手机访问：${addresses.lanUrl}`);
      console.log(await QRCode.toString(addresses.lanUrl, { type: 'terminal', small: true }));
    }
  } catch (error) {
    console.error('Failed to start Richman party server:', error);
    process.exitCode = 1;
  }
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
  console.error('Failed to stop Richman party server:', error);
  process.exitCode = 1;
}
