// 两条互相独立的外观轴：
//   1) 对局皮肤（P2-9）：写入 <html data-theme>，仅作用于对局根容器与对局弹层
//      （gameTheme.css 以 :root[data-theme] 限定作用域），不污染首页 / 大厅全局样式。
//   2) 深色模式（#11）：写入 <html data-appearance>，作用于整站页面级界面
//      （首页 / 大厅 / 单机建房 / 设置 / 通用弹层），由 ui/darkMode.css 覆盖全局变量。
//
// 皮肤多了一个 'auto'（跟随深色模式）：深色模式开启时用「暗夜」，关闭时用「经典」。
// 这样用户只要打开深色模式，对局内也会一起变暗，不必再单独去挑一次皮肤；
// 想锁死某个配色的人仍然可以显式选经典 / 海洋 / 暗夜。

export type ThemeId = 'auto' | 'classic' | 'ocean' | 'midnight';

/** 皮肤解析后的实际配色（'auto' 会被解析成这两者之一）。 */
export type ResolvedThemeId = 'classic' | 'ocean' | 'midnight';

export type AppearanceId = 'light' | 'dark';

export interface ThemeMeta {
  readonly id: ThemeId;
  readonly label: string;
  readonly hint: string;
}

export const THEMES: readonly ThemeMeta[] = [
  { id: 'auto', label: '跟随深色', hint: '深色模式开启时用「暗夜」，关闭时用「经典」' },
  { id: 'classic', label: '经典', hint: '浅色掌机：米白棋盘 + 琥珀按键' },
  { id: 'ocean', label: '海洋', hint: '浅蓝掌机：清爽冷色，日间护眼' },
  { id: 'midnight', label: '暗夜', hint: '深蓝掌机：夜间对局不刺眼' },
];

const THEME_KEY = 'richman:theme';
const APPEARANCE_KEY = 'richman:appearance';

function isThemeId(value: unknown): value is ThemeId {
  return value === 'auto' || value === 'classic' || value === 'ocean' || value === 'midnight';
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

/** 把 'auto' 按当前深色模式解析成一套真实配色。 */
export function resolveTheme(theme: ThemeId, appearance: AppearanceId = getStoredAppearance()): ResolvedThemeId {
  if (theme !== 'auto') return theme;
  return appearance === 'dark' ? 'midnight' : 'classic';
}

/**
 * 把皮肤写入 <html data-theme>；解析结果「经典」移除该属性以走默认（无 data-theme）作用域。
 * 不传参数时读已保存的皮肤与深色模式。
 */
export function applyTheme(
  theme: ThemeId = getStoredTheme(),
  appearance: AppearanceId = getStoredAppearance(),
): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(theme, appearance);
  if (resolved === 'classic') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', resolved);
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

/** 切换并持久化皮肤。 */
export function setTheme(theme: ThemeId): void {
  writeStorage(THEME_KEY, theme);
  applyTheme(theme);
}

/** 切换并持久化深色模式；'auto' 皮肤的解析结果依赖它，因此改完必须重算 data-theme。 */
export function setAppearance(appearance: AppearanceId): void {
  writeStorage(APPEARANCE_KEY, appearance);
  applyAppearance(appearance);
  applyTheme(getStoredTheme(), appearance);
}
