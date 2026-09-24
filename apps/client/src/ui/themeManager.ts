// 两条互相独立的外观轴：
//   1) 对局皮肤（P2-9 / #118）：写入 <html data-theme>，仅作用于对局根容器与对局弹层
//      （gameTheme.css 以 :root[data-theme] 限定作用域），不污染首页 / 大厅全局样式。
//   2) 深色模式（#11）：写入 <html data-appearance>，作用于整站页面级界面
//      （首页 / 大厅 / 单机建房 / 设置 / 通用弹层），由 ui/darkMode.css 覆盖全局变量。
//
// 皮肤有两个「自动挡」（#118）：
//   - 'auto'（跟随深色）：深色模式开启时用「暗夜」，关闭时用「经典」。
//     这样用户只要打开深色模式，对局内也会一起变暗，不必再单独去挑一次皮肤。
//   - 'map'（跟随地图）：按当前地图推荐配色（见 THEME_BY_MAP），让「丝路」自动是沙色、
//     「长江」自动是水色。地图未知 / 非本批地图时回落「经典」；深色模式下仍优先「暗夜」，
//     否则夜间对局会被强制拉回亮色，违背深色模式的本意。
// 想锁死某个配色的人仍然可以显式选经典 / 海洋 / 暗夜 / 森林 / 沙丘。

export type ThemeId = 'auto' | 'map' | 'classic' | 'ocean' | 'midnight' | 'forest' | 'sand';

/** 皮肤解析后的实际配色（'auto' / 'map' 会被解析成其中之一）。 */
export type ResolvedThemeId = 'classic' | 'ocean' | 'midnight' | 'forest' | 'sand';

export type AppearanceId = 'light' | 'dark';

export interface ThemeMeta {
  readonly id: ThemeId;
  readonly label: string;
  readonly hint: string;
}

export const THEMES: readonly ThemeMeta[] = [
  { id: 'auto', label: '跟随深色', hint: '深色模式开启时用「暗夜」，关闭时用「经典」' },
  { id: 'map', label: '跟随地图', hint: '按当前地图自动配色（丝路→沙丘、长江→海洋…），未收录的地图用「经典」' },
  { id: 'classic', label: '经典', hint: '浅色掌机：米白棋盘 + 琥珀按键' },
  { id: 'ocean', label: '海洋', hint: '浅蓝掌机：清爽冷色，日间护眼' },
  { id: 'midnight', label: '暗夜', hint: '深蓝掌机：夜间对局不刺眼' },
  { id: 'forest', label: '森林', hint: '深绿掌机：草木棋盘 + 翠绿按键' },
  { id: 'sand', label: '沙丘', hint: '暖沙掌机：驼色棋盘 + 赭石按键' },
];

/**
 * 地图 id → 推荐皮肤（#118「跟随地图」）。
 *
 * 只按**画面气质**分：沙色给黄土地图（丝路 / 新疆 / 黄河），绿色给山脊地图（长城 / 山西），
 * 水色给江河水系与世界地图，其余回经典。刻意不按 `presentation.theme`（那是盘面自己的配色，
 * 与掌机壳的 48 个变量无关，硬绑会把盘面和外壳撞成一片）。
 *
 * 未在册的地图（含玩家自定义地图）一律回落到 'classic'，绝不抛错。
 */
export const THEME_BY_MAP: Readonly<Record<string, ResolvedThemeId>> = {
  'china-tour': 'classic',
  'classic-tour': 'classic',
  'world-tour': 'ocean',
  'yangtze-tour': 'ocean',
  'pearl-tour': 'ocean',
  'silk-road': 'sand',
  'xinjiang-tour': 'sand',
  'yellow-river': 'sand',
  'great-wall': 'forest',
  'shanxi-tour': 'forest',
};

/** 地图推荐皮肤；未知 / 空 id 回落 'classic'。纯函数，供 UI 说明文案与解析共用。 */
export function recommendedThemeForMap(mapId: string | null | undefined): ResolvedThemeId {
  if (typeof mapId !== 'string' || mapId.length === 0) return 'classic';
  return THEME_BY_MAP[mapId] ?? 'classic';
}

const THEME_KEY = 'richman:theme';
const APPEARANCE_KEY = 'richman:appearance';

const THEME_IDS: readonly ThemeId[] = ['auto', 'map', 'classic', 'ocean', 'midnight', 'forest', 'sand'];

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}


function isAppearanceId(value: unknown): value is AppearanceId {
  return value === 'light' || value === 'dark';
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 忽略持久化失败，仍应用本次会话 */
  }
}

/** 已保存的皮肤；未保存过时回退 'auto'（深色模式关 → 经典，与历史行为一致）。 */
export function getStoredTheme(): ThemeId {
  const raw = readStorage(THEME_KEY);
  return isThemeId(raw) ? raw : 'auto';
}

/** 已保存的深色模式；未保存过时回退浅色。 */
export function getStoredAppearance(): AppearanceId {
  const raw = readStorage(APPEARANCE_KEY);
  return isAppearanceId(raw) ? raw : 'light';
}

/**
 * 把皮肤按「偏好 + 深色模式 + 当前地图」解析成一套真实配色。
 * `mapId` 只在偏好为 'map'（跟随地图）时参与；其它偏好传了也不影响结果。
 */
export function resolveTheme(
  theme: ThemeId,
  appearance: AppearanceId = getStoredAppearance(),
  mapId?: string | null,
): ResolvedThemeId {
  if (theme === 'auto') return appearance === 'dark' ? 'midnight' : 'classic';
  if (theme === 'map') {
    if (appearance === 'dark') return 'midnight';
    return recommendedThemeForMap(mapId);
  }
  return theme;
}

/**
 * 把皮肤写入 <html data-theme>；解析结果「经典」移除该属性以走默认（无 data-theme）作用域。
 * 不传参数时读已保存的皮肤与深色模式。`mapId` 供「跟随地图」解析用。
 */
export function applyTheme(
  theme: ThemeId = getStoredTheme(),
  appearance: AppearanceId = getStoredAppearance(),
  mapId: string | null = null,
): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(theme, appearance, mapId);
  if (resolved === 'classic') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * 按**当前对局地图**重算皮肤（#118）。进对局 / 换地图 / 离开对局时调用：
 * 离开时传 null，让「跟随地图」回到经典，避免沙色皮肤跟着用户回到大厅。
 */
export function applyThemeForMap(mapId: string | null): void {
  applyTheme(getStoredTheme(), getStoredAppearance(), mapId);
}

/** 把深色模式写入 <html data-appearance>；浅色移除该属性以走默认（无 data-appearance）作用域。 */
export function applyAppearance(appearance: AppearanceId = getStoredAppearance()): void {
  if (typeof document === 'undefined') return;
  if (appearance === 'dark') document.documentElement.setAttribute('data-appearance', 'dark');
  else document.documentElement.removeAttribute('data-appearance');
}

/** 一次性把两条轴向都应用到 <html>（启动时调用，避免首屏闪烁）。 */
export function applyAppearancePreferences(): void {
  const appearance = getStoredAppearance();
  applyAppearance(appearance);
  applyTheme(getStoredTheme(), appearance);
}

/**
 * 切换并持久化皮肤。
 * `mapId` 必须由**对局内**的调用方传当前地图：否则选「跟随地图」时会按 null 解析成经典，
 * 棋盘会在设置面板里当场掉色，直到下次进对局才恢复。
 */
export function setTheme(theme: ThemeId, mapId: string | null = null): void {
  writeStorage(THEME_KEY, theme);
  applyTheme(theme, getStoredAppearance(), mapId);
}

/**
 * 切换并持久化深色模式；'auto' / 'map' 皮肤的解析结果都依赖它，因此改完必须重算 data-theme
 * （同样需要当前地图，理由见 setTheme）。
 */
export function setAppearance(appearance: AppearanceId, mapId: string | null = null): void {
  writeStorage(APPEARANCE_KEY, appearance);
  applyAppearance(appearance);
  applyTheme(getStoredTheme(), appearance, mapId);
}
