import { describe, expect, it } from 'vitest';
import { getActiveMapPack, type MapPack, type MapRef } from '@richman/board-data';
import { createClientMapAssetResolver, hasAllClientMapAssets } from './mapAssets';

const exactRef: MapRef = {
  id: 'asset-map',
  version: 2,
  contentHash: 'a'.repeat(64),
};

describe('client map asset resolver', () => {
  it('只解析 app 按 exact MapRef 与包内路径注册的构建资源', () => {
    const resolve = createClientMapAssetResolver([{
      mapRef: exactRef,
      path: 'assets/landmark.webp',
      url: '/assets/landmark.abcd.webp',
    }]);

    expect(resolve(exactRef, 'assets/landmark.webp')).toBe('/assets/landmark.abcd.webp');
    expect(resolve({ ...exactRef, version: 3 }, 'assets/landmark.webp')).toBeNull();
    expect(resolve({ ...exactRef, contentHash: 'b'.repeat(64) }, 'assets/landmark.webp')).toBeNull();
    expect(resolve(exactRef, 'assets/other.webp')).toBeNull();
  });

  it('拒绝重复 exact 注册，避免构建资源被静默覆盖', () => {
    const entry = { mapRef: exactRef, path: 'assets/landmark.webp' as const, url: '/one.webp' };
    expect(() => createClientMapAssetResolver([entry, { ...entry, url: '/two.webp' }]))
      .toThrow(/duplicate client map asset/i);
  });

  it('统一 preflight cell 与 center 所需资源', () => {
    const china = getActiveMapPack('china-tour');
    const pack = {
      ...china,
      presentation: {
        ...china.presentation,
        cells: {
          ...china.presentation.cells,
          0: {
            ...china.presentation.cells[0]!,
            artwork: { type: 'local-asset' as const, path: 'assets/start.webp' as const },
          },
        },
        center: [{
          type: 'image' as const,
          x: 10, y: 10, width: 10, height: 10, role: 'center' as const,
          asset: { type: 'local-asset' as const, path: 'assets/center.webp' as const },
        }],
      },
    } satisfies MapPack;
    const complete = createClientMapAssetResolver([
      { mapRef: pack.ref, path: 'assets/start.webp', url: '/start.webp' },
      { mapRef: pack.ref, path: 'assets/center.webp', url: '/center.webp' },
    ]);

    expect(hasAllClientMapAssets(pack, complete)).toBe(true);
    expect(hasAllClientMapAssets(pack, () => null)).toBe(false);
  });
});
