import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const startupLine = /^本机访问：http:\/\/localhost:(\d+)$/;
// Real process startup has no deterministic virtual clock; these are safety bounds, not sleeps.
const startupTimeoutMs = 3_000;
const shutdownTimeoutMs = 1_000;

type PartyLauncherChild = ChildProcessByStdio<null, Readable, Readable>;

let activeChild: PartyLauncherChild | undefined;

afterEach(async () => {
  const child = activeChild;
  activeChild = undefined;

  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await waitForExit(child, shutdownTimeoutMs).catch(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
  }
});

describe('party launcher runtime', () => {
  it('starts the real script under tsx and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/party.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    const output = collectOutput(child);

    try {
      const port = await waitForLocalStartupLine(child, output);
      expect(port).toBeGreaterThan(0);

      child.kill('SIGTERM');
      const exit = await waitForExit(child, shutdownTimeoutMs);
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForExit(child, shutdownTimeoutMs).catch(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        });
      }
      activeChild = undefined;
    }
  }, 4_500);
});

type ChildOutput = {
  stdout: string;
  stderr: string;
};

type ExitStatus = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function collectOutput(child: PartyLauncherChild): ChildOutput {
  const output: ChildOutput = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
}

async function waitForLocalStartupLine(
  child: PartyLauncherChild,
  output: ChildOutput,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let stdoutBuffer = '';

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for party launcher local URL.\n${formatOutput(output)}`));
    }, startupTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const onStdout = (chunk: string) => {
      stdoutBuffer += chunk;

      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const match = startupLine.exec(line);
        if (match) {
          cleanup();
          resolve(Number(match[1]));
          return;
        }
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Party launcher exited before printing local URL (code ${String(code)}, signal ${String(signal)}).\n${formatOutput(
            output,
          )}`,
        ),
      );
    };

    child.stdout.on('data', onStdout);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function waitForExit(child: PartyLauncherChild, timeoutMs: number): Promise<ExitStatus> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise<ExitStatus>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for party launcher to exit.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function formatOutput(output: ChildOutput): string {
  return [`stdout:\n${output.stdout || '<empty>'}`, `stderr:\n${output.stderr || '<empty>'}`].join('\n');
}
