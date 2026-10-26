import type { MapPack, MapRef, PackageLocalAssetPath } from '@richman/board-data';

export type ClientMapAssetResolver = (
  mapRef: MapRef,
  path: PackageLocalAssetPath,
) => string | null;

export interface ClientMapAssetRegistration {
  readonly mapRef: MapRef;
  readonly path: PackageLocalAssetPath;
  /** 由 Vite import 生成的 app-owned URL；地图 manifest 不能提供该值。 */
  readonly url: string;
}

function assetKey(mapRef: MapRef, path: PackageLocalAssetPath): string {
  return `${mapRef.id}@${mapRef.version}#${mapRef.contentHash}:${path}`;
}

export function createClientMapAssetResolver(
  registrations: readonly ClientMapAssetRegistration[],
): ClientMapAssetResolver {
  const assets = new Map<string, string>();
  for (const registration of registrations) {
    const key = assetKey(registration.mapRef, registration.path);
    if (assets.has(key)) throw new Error(`Duplicate client map asset: ${key}`);
    assets.set(key, registration.url);
  }
  return (mapRef, path) => assets.get(assetKey(mapRef, path)) ?? null;
}

// 资源 URL 必须由构建产物显式注册；地图数据本身不能拼接或注入 URL。
// 当前 production map 只使用 built-in icon，因此注册表为空；新增包内图片时需在这里
// 通过静态 import 的 URL 与 exact MapRef 一起登记，缺项会在 mapResolver 阶段明确兼容失败。
export const resolveClientMapAsset = createClientMapAssetResolver([]);

export function hasAllClientMapAssets(
  pack: MapPack,
  resolveAsset: ClientMapAssetResolver = resolveClientMapAsset,
): boolean {
  for (const cell of Object.values(pack.presentation.cells)) {
    if (cell.artwork?.type === 'local-asset' && resolveAsset(pack.ref, cell.artwork.path) === null) {
      return false;
    }
  }
  return pack.presentation.center.every((decoration) => (
    decoration.type !== 'image' || resolveAsset(pack.ref, decoration.asset.path) !== null
  ));
}
