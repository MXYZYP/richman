import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { getPartyAddresses } from '../party/networkAddress';

type SupportedFamily = NetworkInterfaceInfo['family'] | 4 | 6;
type TestNetworkInterfaceInfo = Omit<NetworkInterfaceInfo, 'family'> & {
  family: SupportedFamily;
};
type TestNetworkInterfaces = Record<string, TestNetworkInterfaceInfo[] | undefined>;


function address(address: string, family: SupportedFamily, internal: boolean): TestNetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    cidr: `${address}/24`,
    mac: '00:00:00:00:00:00',
    netmask: '255.255.255.0',
    scopeid: 0,
  };
}

describe('getPartyAddresses', () => {
  it('selects an external IPv4 address from the first eligible interface', () => {
    expect(
      getPartyAddresses(
        ({
          en0: [address('192.168.1.42', 'IPv4', false)],
        } satisfies TestNetworkInterfaces),
        5173,
      ),
    ).toEqual({
      localUrl: 'http://localhost:5173',
      lanUrl: 'http://192.168.1.42:5173',
    });
  });

  it('skips empty, internal, and IPv6 entries before selecting the next external IPv4', () => {
    expect(
      getPartyAddresses(
        ({
          emptyAdapter: [],
          missingAdapter: undefined,
          lo0: [address('127.0.0.1', 'IPv4', true)],
          bridge0: [address('fe80::1', 'IPv6', false)],
          en1: [address('10.0.0.25', 'IPv4', false)],
        } satisfies TestNetworkInterfaces),
        61234,
      ),
    ).toEqual({
      localUrl: 'http://localhost:61234',
      lanUrl: 'http://10.0.0.25:61234',
    });
  });

  it('returns a null LAN URL when no external IPv4 address is present', () => {
    expect(
      getPartyAddresses(
        ({
          lo0: [address('127.0.0.1', 'IPv4', true)],
          utun0: [address('fe80::2', 'IPv6', false)],
          emptyAdapter: [],
          missingAdapter: undefined,
        } satisfies TestNetworkInterfaces),
        4000,
      ),
    ).toEqual({
      localUrl: 'http://localhost:4000',
      lanUrl: null,
    });
  });

  it('accepts numeric family 4 as IPv4 for supported Node typings', () => {
    expect(
      getPartyAddresses(
        ({
          en0: [address('172.16.0.9', 4, false)],
        } satisfies TestNetworkInterfaces),
        3001,
      ),
    ).toEqual({
      localUrl: 'http://localhost:3001',
      lanUrl: 'http://172.16.0.9:3001',
    });
  });

  it('interpolates the supplied port into both local and LAN URLs', () => {
    expect(
      getPartyAddresses(
        ({
          en0: [address('192.168.50.8', 'IPv4', false)],
        } satisfies TestNetworkInterfaces),
        49152,
      ),
    ).toEqual({
      localUrl: 'http://localhost:49152',
      lanUrl: 'http://192.168.50.8:49152',
    });
  });
});
