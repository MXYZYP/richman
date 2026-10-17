// Source-level guards for the board route layer stack.
//
// Regression: `.map-route` used to sit at z-index 2, BELOW `.map-cell` (3). Because the
// route is drawn through tile centres, every map's track was hidden behind every tile and
// only fragments showed in the gaps — which is why all thirteen boards looked like loose
// tiles with scattered dashes instead of a connected track. Three maps even declared
// zIndex: 4 in their manifests and it never took effect, because the CSS fallback won.
//
// Why source assertions: this package has no @vue/test-utils, so .vue behaviour is
// pinned by reading the file. The layer order is a pure CSS concern with no runtime hook.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveMapPack } from '@richman/board-data';

const here = dirname(fileURLToPath(import.meta.url));
const board = readFileSync(resolve(here, '..', 'components', 'GameBoard.vue'), 'utf8');

/** Reads a CSS rule's z-index. Comments are stripped first: a comment that mentions a
 *  z-index value would otherwise be read as the declaration. */
function zIndexOf(selector: string): number {
  const clean = board.replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const multi = new RegExp(escaped + '\\s*\\{\\s*\\n([\\s\\S]*?)\\n\\s*\\}').exec(clean);
  const single = new RegExp(escaped + '\\s*\\{([^{}]*)\\}').exec(clean);
  const body = multi !== null ? multi[1] : (single !== null ? single[1] : null);
  if (body === null) throw new Error(`no CSS rule for ${selector}`);
  const found = /z-index:\s*(-?\d+)/.exec(body);
  if (found === null) throw new Error(`${selector} declares no z-index`);
  return Number(found[1]);
}

describe('棋盘路线的层级', () => {
  it('折线必须压在格子之上 —— 路线穿格心，层级不够就只剩格子间的碎线', () => {
    expect(zIndexOf('.map-route')).toBeGreaterThan(zIndexOf('.map-cell'));
  });

  it('中央装饰必须压在折线之上，否则棋路会横穿地图名', () => {
    expect(zIndexOf('.center-decoration')).toBeGreaterThan(zIndexOf('.map-route'));
  });

  it('不得再用硬编码样式覆盖 manifest 声明的路线外观', () => {
    // The override silently discarded every map's strokeWidth / dashPattern / opacity and
    // its theme `route` colour, forcing all thirteen boards to the same thin grey dashes.
    const leftovers = board.split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /strokeWidth:\s*0\.45|strokeDasharray:\s*'1\.2 1'|stroke:\s*'var\(--color-text\)'/.test(line));
    expect(leftovers, `hard-coded route styles remain: ${leftovers.map(([n]) => n).join(', ')}`)
      .toEqual([]);
  });
});

describe('每张正式地图的棋盘呈现', () => {
  const mapIds = [
    'china-tour', 'classic-tour', 'world-tour', 'silk-road', 'great-wall',
    'yellow-river', 'yangtze-tour', 'pearl-tour', 'xinjiang-tour', 'shanxi-tour',
    'northeast-tour', 'yuncheng-tour', 'sanguo-tour',
  ];

  it.each(mapIds)('%s 的棋路不会被格子遮住，且中央有面板与地图名', (mapId) => {
    const pack = getActiveMapPack(mapId);
    const presentation = pack.presentation;
    const cellZ = zIndexOf('.map-cell');

    // Tile centres, so we can tell whether a route threads the tiles.
    const centres = new Set(pack.game.board.cells.map((cell) => {
      if (cell.id === undefined) throw new Error('a board cell has no id');
      const p = presentation.cells[cell.id]!;
      return `${(p.x + p.width / 2).toFixed(2)},${(p.y + p.height / 2).toFixed(2)}`;
    }));

    // RouteDecoration is a union (line | polyline | path); only the polyline variant
    // carries `points`, so narrow before reading it.
    const threaded = (presentation.routes ?? []).filter((route) => {
      if (route.type !== 'polyline') return false;
      return route.points.some((point) => centres.has(`${point.x.toFixed(2)},${point.y.toFixed(2)}`));
    });
    // 穿格心的折线只有两种合法层级：
    //   > cellZ —— 线压在格子之上，看得见、但会从格名上横过去；
    //   < cellZ —— 线沉到格子之下，格名干净，线只在格与格的缝里露出。
    // 唯一不能接受的是「和格子同层」（z === cellZ）：那条线会随 DOM 顺序时隐时现。
    // 11-17 之前这里是硬性的 >，于是十三张图一律穿字；运城 / 山西 / 东北 这三张
    // 13×10 的宫格图因此改成 <（见下面那条专门的用例）。
    for (const route of threaded) {
      const routeZ = route.zIndex ?? 0;
      expect(Math.abs(routeZ - cellZ), `${mapId}: 折线不能与格子同层(z=${cellZ})`)
        .toBeGreaterThanOrEqual(1);
    }

    const centre = presentation.center ?? [];
    // Narrow via a type guard: annotating the callback param as `{ type: string }` would
    // erase CenterDecoration's discriminated union and make `.text` / `.zIndex` vanish.
    const panel = centre.find((d): d is Extract<typeof d, { type: 'panel' }> => d.type === 'panel');
    const title = centre.find((d): d is Extract<typeof d, { type: 'text' }> => d.type === 'text');
    expect(panel, `${mapId}: 中央缺少面板`).toBeDefined();
    expect(title, `${mapId}: 中央缺少地图名`).toBeDefined();
    expect(panel!.role).toBe('center');
    expect(title!.role).toBe('title');
    expect(String(title!.text ?? '').length).toBeGreaterThan(0);
    // Title paints above the panel it sits on.
    expect(title!.zIndex ?? 0).toBeGreaterThan(panel!.zIndex ?? 0);
  });

  // 11-17 修正：运城 / 山西 / 东北 是 13×10 的宫格图 —— 格子又宽又高、格名几乎填满整格，
  // 而折线是按「格心连线」画的，正好从字上横过去（用户：「路径线把文字都挡住了」）。
  // 这三张图把路线沉到格子之下（z=2 < cellZ），线只在格缝里露出：棋路仍然连得起来，
  // 格名不再被切。别再把这三张图的 zIndex 改回 4。
  it.each(['yuncheng-tour', 'shanxi-tour', 'northeast-tour'])(
    '%s 的棋路沉在格子之下（宫格图的格名不能被穿格心的线压住）',
    (mapId) => {
      const pack = getActiveMapPack(mapId);
      const cellZ = zIndexOf('.map-cell');
      const routes = pack.presentation.routes ?? [];
      expect(routes.length, `${mapId}: 应当有棋路`).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.zIndex ?? 0, `${mapId}: 宫格图的棋路必须在格子(z=${cellZ})之下`)
          .toBeLessThan(cellZ);
      }
    },
  );
});