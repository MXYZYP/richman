import type { NetworkInterfaceInfo } from 'node:os';

type SupportedFamily = NetworkInterfaceInfo['family'] | 4 | 6;
type NetworkInterfaceInfoLike = Omit<NetworkInterfaceInfo, 'family'> & {
  family: SupportedFamily;
};
type NetworkInterfacesLike = Record<string, readonly NetworkInterfaceInfoLike[] | undefined>;

export type PartyAddresses = {
  localUrl: string;
  lanUrl: string | null;
};

export function getPartyAddresses(
  networkInterfaces: NetworkInterfacesLike,
  port: number,
): PartyAddresses {
  const localUrl = `http://localhost:${port}`;

  for (const entries of Object.values(networkInterfaces)) {
    if (entries === undefined) {
      continue;
    }

    for (const entry of entries) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) {
        continue;
      }

      return {
        localUrl,
        lanUrl: `http://${entry.address}:${port}`,
      };
    }
  }

  return {
    localUrl,
    lanUrl: null,
  };
}
