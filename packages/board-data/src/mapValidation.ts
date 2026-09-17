import { canonicalStringify, computeContentHash } from './hash';
import type { MapPack, RuleModuleRef } from './mapTypes';
import type { CellEffect } from './types';

function fail(path: string, reason: string): never {
  throw new Error(`${path}: ${reason}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertPositiveFinite(value: unknown, path: string): asserts value is number {
  if (!isFiniteNumber(value) || value <= 0) fail(path, 'must be a positive finite number');
}

function assertNonNegativeFinite(value: unknown, path: string): asserts value is number {
  if (!isFiniteNumber(value) || value < 0) fail(path, 'must be a non-negative finite number');
}

function assertUnitRate(value: unknown, path: string): void {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    fail(path, 'must be between 0 and 1');
  }
}

function assertNonDecreasing(values: unknown, path: string): asserts values is number[] {
  if (!Array.isArray(values) || values.some((value) => !isFiniteNumber(value) || value < 0)) {
    fail(path, 'must contain finite non-negative numbers');
  }
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! < values[index - 1]!) fail(path, 'must be non-decreasing');
  }
}

function assertConfig(pack: MapPack): void {
  const config = pack.game.config;
  assertNonNegativeFinite(config.initialCash, 'game.config.initialCash');
  if (!isFiniteNumber(config.passStartSalary) || config.passStartSalary < 0) {
    fail('game.config.passStartSalary', 'must be a finite non-negative number');
  }
  if (!Number.isSafeInteger(config.maxHouseLevel) || config.maxHouseLevel < 0) {
    fail('game.config.maxHouseLevel', 'must be a non-negative integer');
  }
  assertUnitRate(config.sellHouseRefundRate, 'game.config.sellHouseRefundRate');
  assertUnitRate(config.sellLandRate, 'game.config.sellLandRate');
  assertUnitRate(config.mortgageInterestRate, 'game.config.mortgageInterestRate');

  if (!Array.isArray(config.utilityMultipliers) || config.utilityMultipliers.length !== 2) {
    fail('game.config.utilityMultipliers', 'must contain exactly two values');
  }
  config.utilityMultipliers.forEach((value, index) => {
    assertNonNegativeFinite(value, `game.config.utilityMultipliers[${index}]`);
  });
  if (config.utilityMultipliers[1] < config.utilityMultipliers[0]) {
    fail('game.config.utilityMultipliers', 'must be non-decreasing');
  }
  if (!Number.isSafeInteger(config.jailExitMinRoll) || config.jailExitMinRoll <= 0) {
    fail('game.config.jailExitMinRoll', 'must be a positive integer');
  }
  if (!Number.isSafeInteger(config.jailMaxAttempts) || config.jailMaxAttempts <= 0) {
    fail('game.config.jailMaxAttempts', 'must be a positive integer');
  }
  if (!Array.isArray(config.cashGoalPresets) || config.cashGoalPresets.length === 0) {
    fail('game.config.cashGoalPresets', 'must be a non-empty array');
  }
  const goals = new Set<number>();
  config.cashGoalPresets.forEach((goal, index) => {
    assertPositiveFinite(goal, `game.config.cashGoalPresets[${index}]`);
    if (goal <= config.initialCash) {
      fail(`game.config.cashGoalPresets[${index}]`, 'must be greater than initialCash');
    }
    if (goals.has(goal)) fail('game.config.cashGoalPresets', 'must contain unique values');
    goals.add(goal);
  });
  if (config.diceMode !== 'two_dice') fail('game.config.diceMode', 'must be two_dice');
  if (config.airportBranchDice !== 1) {
    fail('game.config.airportBranchDice', 'must be exactly 1');
  }
  if (config.jailEnabled !== false) fail('game.config.jailEnabled', 'must be false');
}

function assertEffect(
  effectValue: unknown,
  path: string,
  cellIds: ReadonlySet<number>,
  knownModuleKeys: ReadonlySet<string>,
  requiredModuleKeys: ReadonlySet<string>,
): void {
  if (effectValue === null || typeof effectValue !== 'object') fail(path, 'must be an effect object');
  const effect = effectValue as CellEffect;

  switch (effect.type) {
    case 'module':
      assertModuleEnvelopeRef(effect.module, `${path}.module`, knownModuleKeys, requiredModuleKeys);
      if (typeof effect.effectType !== 'string' || effect.effectType.trim() === '') {
        fail(`${path}.effectType`, 'must be a non-empty string');
      }
      assertJsonPayload(effect.payload, `${path}.payload`);
      assertWorldTourEffectPayload(effect, path);
      break;
    case 'move_to':
      if (!Number.isSafeInteger(effect.cellId) || !cellIds.has(effect.cellId!)) {
        fail(`${path}.cellId`, 'must reference an existing cell');
      }
      if (typeof effect.collectSalary !== 'boolean') {
        fail(`${path}.collectSalary`, 'must be a boolean');
      }
      break;
    case 'move_steps':
      if (!Number.isSafeInteger(effect.steps) || effect.steps === 0) {
        fail(`${path}.steps`, 'must be a non-zero integer');
      }
      break;
    case 'pay_bank':
    case 'receive_bank':
    case 'pay_each_player':
    case 'receive_from_each_player':
      if (!isFiniteNumber(effect.amount) || effect.amount < 0) {
        fail(`${path}.amount`, 'must be a finite non-negative number');
      }
      break;
    case 'repairs':
      if (!isFiniteNumber(effect.perHouse) || effect.perHouse < 0) {
        fail(`${path}.perHouse`, 'must be a finite non-negative number');
      }
      if (!isFiniteNumber(effect.perHotel) || effect.perHotel < 0) {
        fail(`${path}.perHotel`, 'must be a finite non-negative number');
      }
      break;
    case 'skip_turn':
      if (!Number.isSafeInteger(effect.turns) || effect.turns! <= 0) {
        fail(`${path}.turns`, 'must be a positive integer');
      }
      break;
    case 'draw_card':
      if (effect.deck !== 'chance' && effect.deck !== 'destiny') {
        fail(`${path}.deck`, 'must be chance or destiny');
      }
      break;
    case 'none':
      break;
    default:
      fail(`${path}.type`, 'is not a supported core effect');
  }
}

const THEME_ROLES = ['board', 'cell', 'border', 'route', 'title', 'decoration', 'center'] as const;
const BUILT_IN_ICONS = new Set([
  'start', 'airport', 'chance', 'destiny', 'tax',
  'special-food', 'special-moon', 'world',
]);
const CORE_CELL_TYPES = new Set([
  'start', 'property', 'chance', 'destiny', 'tax', 'airport', 'special', 'world',
]);
const GEOMETRY_EPSILON = 1e-6;

function assertModuleEnvelopeRef(
  ref: RuleModuleRef,
  path: string,
  knownModuleKeys: ReadonlySet<string>,
  requiredModuleKeys: ReadonlySet<string>,
): void {
  if (ref === null || typeof ref !== 'object') fail(path, 'must be a rule module ref');
  if (typeof ref.id !== 'string' || ref.id.trim() === '') fail(`${path}.id`, 'must be non-empty');
  if (!Number.isSafeInteger(ref.version) || ref.version <= 0) {
    fail(`${path}.version`, 'must be a positive safe integer');
  }
  const key = `${ref.id}@${ref.version}`;
  if (!knownModuleKeys.has(key)) fail(path, `unknown rule module ${key}`);
  if (!requiredModuleKeys.has(key)) fail(path, `rule module ${key} must be required by this map`);
}

function assertJsonPayload(payload: unknown, path: string): void {
  try {
    canonicalStringify(payload);
  } catch {
    fail(path, 'must be valid JSON data');
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
}

function assertExactKeys(value: unknown, allowedKeys: readonly string[], path: string): void {
  assertRecord(value, path);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpected !== undefined) fail(path, `unexpected property ${unexpected}`);
}

function isWorldTourModule(ref: RuleModuleRef): boolean {
  return ref.id === 'world-tour' && ref.version === 1;
}

function assertEmptyPayload(payload: unknown, path: string): void {
  assertExactKeys(payload, [], path);
}

function assertWorldTourEffectPayload(effect: any, path: string): void {
  if (!isWorldTourModule(effect.module)) return;

  const payloadPath = `${path}.payload`;
  switch (effect.effectType) {
    case 'toll-immunity':
    case 'bus-choice':
    case 'free-upgrade':
      assertEmptyPayload(effect.payload, payloadPath);
      return;
    case 'short-flight':
      assertExactKeys(effect.payload, ['cost', 'maxForwardSteps'], payloadPath);
      assertNonNegativeFinite(effect.payload.cost, `${payloadPath}.cost`);
      if (!Number.isSafeInteger(effect.payload.maxForwardSteps) || effect.payload.maxForwardSteps <= 0) {
        fail(`${payloadPath}.maxForwardSteps`, 'must be a positive safe integer');
      }
      return;
    case 'long-flight':
      assertExactKeys(effect.payload, ['cost'], payloadPath);
      assertNonNegativeFinite(effect.payload.cost, `${payloadPath}.cost`);
      return;
    case 'dice-duel':
    case 'lowest-cash-aid':
      assertExactKeys(effect.payload, ['amount'], payloadPath);
      assertPositiveFinite(effect.payload.amount, `${payloadPath}.amount`);
      return;
    default:
      fail(`${path}.effectType`, 'is not supported by world-tour@1');
  }
}

interface WorldTourAirportPayload {
  outerNextId: number;
  branchEntryId: number;
  branchCellIds: number[];
  mergeCellId: number;
}

function assertWorldTourAirportPayloadShape(payload: unknown, path: string): WorldTourAirportPayload {
  assertExactKeys(
    payload,
    ['outerNextId', 'branchEntryId', 'branchCellIds', 'mergeCellId'],
    path,
  );
  const value = payload as unknown as WorldTourAirportPayload;
  for (const key of ['outerNextId', 'branchEntryId', 'mergeCellId'] as const) {
    if (!Number.isSafeInteger(value[key])) {
      fail(`${path}.${key}`, 'must be a safe integer');
    }
  }
  if (!Array.isArray(value.branchCellIds) || value.branchCellIds.length === 0) {
    fail(`${path}.branchCellIds`, 'must be a non-empty array');
  }
  const branchIds = new Set<number>();
  value.branchCellIds.forEach((cellId, index) => {
    if (!Number.isSafeInteger(cellId)) {
      fail(`${path}.branchCellIds[${index}]`, 'must be a safe integer');
    }
    if (branchIds.has(cellId)) {
      fail(`${path}.branchCellIds[${index}]`, 'must be unique');
    }
    branchIds.add(cellId);
  });
  return value;
}

function assertMapPackStructure(value: unknown): asserts value is MapPack {
  assertExactKeys(value, ['ref', 'metadata', 'game', 'presentation'], 'mapPack');
  const pack = value as any;
  assertExactKeys(pack.ref, ['id', 'version', 'contentHash'], 'ref');
  assertRecord(pack.metadata, 'metadata');
  assertRecord(pack.game, 'game');
  assertRecord(pack.game.board, 'game.board');
  if (!Array.isArray(pack.game.board.cells)) fail('game.board.cells', 'must be an array');
  pack.game.board.cells.forEach((cell: unknown, index: number) => {
    assertRecord(cell, `game.board.cells[${index}]`);
  });

  assertRecord(pack.game.cards, 'game.cards');
  for (const deckName of ['chance', 'destiny'] as const) {
    const deck = pack.game.cards[deckName];
    if (!Array.isArray(deck)) fail(`game.cards.${deckName}`, 'must be an array');
    deck.forEach((card: unknown, index: number) => {
      assertRecord(card, `game.cards.${deckName}[${index}]`);
    });
  }
  assertRecord(pack.game.config, 'game.config');
  if (!Array.isArray(pack.game.requiredRuleModules)) {
    fail('game.requiredRuleModules', 'must be an array');
  }
  pack.game.requiredRuleModules.forEach((module: unknown, index: number) => {
    assertRecord(module, `game.requiredRuleModules[${index}]`);
  });

  assertRecord(pack.presentation, 'presentation');
  assertRecord(pack.presentation.canvas, 'presentation.canvas');
  assertRecord(pack.presentation.cells, 'presentation.cells');
  for (const [cellId, placement] of Object.entries(pack.presentation.cells)) {
    assertRecord(placement, `presentation.cells.${cellId}`);
  }
  if (!Array.isArray(pack.presentation.routes)) fail('presentation.routes', 'must be an array');
  pack.presentation.routes.forEach((route: unknown, index: number) => {
    assertRecord(route, `presentation.routes[${index}]`);
  });
  if (!Array.isArray(pack.presentation.center)) fail('presentation.center', 'must be an array');
  pack.presentation.center.forEach((decoration: unknown, index: number) => {
    assertRecord(decoration, `presentation.center[${index}]`);
  });
  assertRecord(pack.presentation.theme, 'presentation.theme');
  assertRecord(pack.presentation.theme.colors, 'presentation.theme.colors');
  assertRecord(pack.presentation.theme.propertyBands, 'presentation.theme.propertyBands');
}

function assertOptionalText(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
    fail(path, 'must be a non-empty string when provided');
  }
}

function assertPoint(value: any, path: string, canvasSize: number): void {
  if (value === null || typeof value !== 'object') fail(path, 'must be a point');
  assertExactKeys(value, ['x', 'y'], path);
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y)
    || value.x < 0 || value.y < 0 || value.x > canvasSize || value.y > canvasSize) {
    fail(path, 'must be a finite point within canvas');
  }
}

function assertRectangle(value: any, path: string, canvasSize: number): void {
  if (!isFiniteNumber(value.x)) fail(`${path}.x`, 'must be finite');
  if (!isFiniteNumber(value.y)) fail(`${path}.y`, 'must be finite');
  assertPositiveFinite(value.width, `${path}.width`);
  assertPositiveFinite(value.height, `${path}.height`);
  if (value.x < -GEOMETRY_EPSILON || value.y < -GEOMETRY_EPSILON
    || value.x + value.width > canvasSize + GEOMETRY_EPSILON
    || value.y + value.height > canvasSize + GEOMETRY_EPSILON) {
    fail(path, 'rectangle must be within canvas');
  }
}

function assertLayerFields(value: any, path: string): void {
  if (value.rotation !== undefined && !isFiniteNumber(value.rotation)) {
    fail(`${path}.rotation`, 'must be finite');
  }
  if (value.zIndex !== undefined && !Number.isSafeInteger(value.zIndex)) {
    fail(`${path}.zIndex`, 'must be an integer');
  }
}

function assertThemeRole(value: unknown, path: string): void {
  if (typeof value !== 'string' || !(THEME_ROLES as readonly string[]).includes(value)) {
    fail(path, 'must be an allowlisted theme role');
  }
}

function assertLocalAsset(asset: any, path: string, knownAssetPaths: ReadonlySet<string>): void {
  if (asset === null || typeof asset !== 'object') fail(path, 'must be a local asset object');
  assertExactKeys(asset, ['type', 'path'], path);
  const assetPath = asset.path;
  const segments = typeof assetPath === 'string' ? assetPath.split('/') : [];
  const safePath = typeof assetPath === 'string'
    && segments[0] === 'assets'
    && segments.length >= 2
    && segments.slice(1).every((segment) => segment.trim() !== '' && segment !== '.' && segment !== '..')
    && !/[\\%?#:\u0000-\u001f\u007f]/.test(assetPath)
    && /\.(?:png|jpe?g|webp|avif)$/i.test(segments.at(-1)!);
  if (asset.type !== 'local-asset' || !safePath) {
    fail(`${path}.path`, 'must be a safe package-local image under assets/');
  }
  if (!knownAssetPaths.has(assetPath)) {
    fail(`${path}.path`, 'must reference a known package asset');
  }
}

function assertArtwork(artwork: any, path: string, knownAssetPaths: ReadonlySet<string>): void {
  if (artwork === null || typeof artwork !== 'object') fail(path, 'must be an artwork object');
  if (artwork.type === 'built-in-icon') {
    assertExactKeys(artwork, ['type', 'icon'], path);
    if (!BUILT_IN_ICONS.has(artwork.icon)) fail(`${path}.icon`, 'must be an allowlisted semantic icon');
    return;
  }
  if (artwork.type === 'local-asset') {
    assertLocalAsset(artwork, path, knownAssetPaths);
    return;
  }
  fail(`${path}.type`, 'must be built-in-icon or local-asset');
}

function assertPathData(d: unknown, path: string, canvasSize: number): void {
  if (typeof d !== 'string' || d.trim() === '') fail(path, 'must be a non-empty path');
  const tokenPattern = /[MLHVZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const tokens = d.match(tokenPattern) ?? [];
  const leftovers = d.replace(tokenPattern, '').replace(/[\s,]/g, '');
  if (leftovers !== '' || tokens[0] !== 'M') {
    fail(path, 'supported absolute commands are M, L, H, V, and Z');
  }
  const isCommand = (token: string | undefined): boolean => token !== undefined && /^[MLHVZ]$/.test(token);
  let index = 0;
  let x = 0;
  let y = 0;
  while (index < tokens.length) {
    const command = tokens[index++]!;
    if (!isCommand(command)) fail(path, 'must place coordinates after a path command');
    if (command === 'Z') continue;
    let coordinateCount = 0;
    while (index < tokens.length && !isCommand(tokens[index])) {
      if (command === 'M' || command === 'L') {
        if (index + 1 >= tokens.length || isCommand(tokens[index + 1])) {
          fail(path, `${command} requires coordinate pairs`);
        }
        x = Number(tokens[index++]);
        y = Number(tokens[index++]);
      } else if (command === 'H') {
        x = Number(tokens[index++]);
      } else {
        y = Number(tokens[index++]);
      }
      coordinateCount += 1;
      assertPoint({ x, y }, path, canvasSize);
    }
    if (coordinateCount === 0) fail(path, `${command} requires coordinates`);
  }
}

function assertRoute(route: any, path: string, canvasSize: number): void {
  if (route === null || typeof route !== 'object') fail(path, 'must be a route object');
  const baseKeys = ['type', 'role', 'strokeWidth', 'dashPattern', 'lineCap', 'opacity', 'zIndex'];
  assertThemeRole(route.role, `${path}.role`);
  assertPositiveFinite(route.strokeWidth, `${path}.strokeWidth`);
  if (route.dashPattern !== undefined) {
    if (!Array.isArray(route.dashPattern) || route.dashPattern.length === 0
      || route.dashPattern.some((value: unknown) => !isFiniteNumber(value) || value <= 0)) {
      fail(`${path}.dashPattern`, 'must contain positive finite numbers');
    }
  }
  if (route.lineCap !== undefined && !['butt', 'round', 'square'].includes(route.lineCap)) {
    fail(`${path}.lineCap`, 'must be butt, round, or square');
  }
  if (route.opacity !== undefined
    && (!isFiniteNumber(route.opacity) || route.opacity < 0 || route.opacity > 1)) {
    fail(`${path}.opacity`, 'must be between 0 and 1');
  }
  if (route.zIndex !== undefined && !Number.isSafeInteger(route.zIndex)) {
    fail(`${path}.zIndex`, 'must be an integer');
  }

  if (route.type === 'line') {
    assertExactKeys(route, [...baseKeys, 'from', 'to'], path);
    assertPoint(route.from, `${path}.from`, canvasSize);
    assertPoint(route.to, `${path}.to`, canvasSize);
  } else if (route.type === 'polyline') {
    assertExactKeys(route, [...baseKeys, 'points'], path);
    if (!Array.isArray(route.points) || route.points.length < 2) {
      fail(`${path}.points`, 'must contain at least two points');
    }
    route.points.forEach((point: unknown, index: number) => {
      assertPoint(point, `${path}.points[${index}]`, canvasSize);
    });
  } else if (route.type === 'path') {
    assertExactKeys(route, [...baseKeys, 'd'], path);
    assertPathData(route.d, `${path}.d`, canvasSize);
  } else {
    fail(`${path}.type`, 'must be line, polyline, or path');
  }
}

function assertPresentation(pack: MapPack, knownAssetPaths: ReadonlySet<string>): void {
  const presentation: any = pack.presentation;
  assertExactKeys(presentation, ['canvas', 'cells', 'routes', 'center', 'theme'], 'presentation');
  assertExactKeys(presentation.canvas, ['size'], 'presentation.canvas');
  assertPositiveFinite(presentation.canvas.size, 'presentation.canvas.size');
  const canvasSize = presentation.canvas.size;

  const gameIds = new Set(pack.game.board.cells.map((cell) => cell.id));
  assertRecord(presentation.cells, 'presentation.cells');
  const placementEntries = Object.entries(presentation.cells) as [string, any][];
  const placementIds = new Set<number>();
  for (const [key, placement] of placementEntries) {
    const cellId = Number(key);
    if (!Number.isSafeInteger(cellId) || String(cellId) !== key) {
      fail(`presentation.cells.${key}`, 'must use a canonical integer cell ID');
    }
    if (!gameIds.has(cellId)) fail(`presentation.cells.${key}`, 'references an unknown game cell');
    placementIds.add(cellId);
    const path = `presentation.cells.${key}`;
    assertExactKeys(placement, [
      'x', 'y', 'width', 'height', 'rotation', 'zIndex', 'overlapWith', 'shortLabel', 'compactLabel',
      'artwork', 'propertyBand', 'accessibilityLabel', 'mobile',
    ], path);
    assertRectangle(placement, path, canvasSize);
    if (placement.mobile !== undefined) {
      assertExactKeys(placement.mobile, ['x', 'y', 'width', 'height'], `${path}.mobile`);
      assertRectangle(placement.mobile, `${path}.mobile`, canvasSize);
    }
    assertLayerFields(placement, path);
    if (typeof placement.shortLabel !== 'string' || placement.shortLabel.trim() === '') {
      fail(`${path}.shortLabel`, 'must be a non-empty string');
    }
    assertOptionalText(placement.compactLabel, `${path}.compactLabel`);
    assertOptionalText(placement.accessibilityLabel, `${path}.accessibilityLabel`);
    if (placement.artwork !== undefined) {
      assertArtwork(placement.artwork, `${path}.artwork`, knownAssetPaths);
    }
    if (placement.overlapWith !== undefined) {
      if (!Array.isArray(placement.overlapWith)) fail(`${path}.overlapWith`, 'must be an array');
      const declaredIds = new Set<number>();
      placement.overlapWith.forEach((targetId: unknown) => {
        if (!Number.isSafeInteger(targetId)) fail(`${path}.overlapWith`, 'must contain safe integer IDs');
        if (targetId === cellId) fail(`${path}.overlapWith`, 'must not reference self');
        if (!gameIds.has(targetId as number)) fail(`${path}.overlapWith`, 'must reference an existing cell');
        if (declaredIds.has(targetId as number)) fail(`${path}.overlapWith`, 'must contain unique IDs');
        declaredIds.add(targetId as number);
      });
    }
  }
  for (const cellId of gameIds) {
    if (!placementIds.has(cellId)) fail('presentation.cells', `missing placement for cell ${cellId}`);
  }

  for (let left = 0; left < placementEntries.length; left += 1) {
    const [leftId, leftCell] = placementEntries[left]!;
    for (let right = left + 1; right < placementEntries.length; right += 1) {
      const [rightId, rightCell] = placementEntries[right]!;
      for (const viewport of ['desktop', 'mobile'] as const) {
        const leftRectangle = viewport === 'mobile' ? leftCell.mobile ?? leftCell : leftCell;
        const rightRectangle = viewport === 'mobile' ? rightCell.mobile ?? rightCell : rightCell;
        const xOverlap = Math.min(leftRectangle.x + leftRectangle.width, rightRectangle.x + rightRectangle.width)
          - Math.max(leftRectangle.x, rightRectangle.x);
        const yOverlap = Math.min(leftRectangle.y + leftRectangle.height, rightRectangle.y + rightRectangle.height)
          - Math.max(leftRectangle.y, rightRectangle.y);
        const declared = leftCell.overlapWith?.includes(Number(rightId))
          || rightCell.overlapWith?.includes(Number(leftId));
        const explicitlyLayered = (leftCell.zIndex ?? 0) !== (rightCell.zIndex ?? 0);
        if (xOverlap > GEOMETRY_EPSILON && yOverlap > GEOMETRY_EPSILON
          && (!declared || !explicitlyLayered)) {
          fail(
            `presentation.cells.${leftId} and presentation.cells.${rightId}`,
            `${viewport} rectangles overlap without a valid overlapWith declaration and different zIndex`,
          );
        }
      }
    }
  }
  for (const [sourceId, source] of placementEntries) {
    for (const targetId of source.overlapWith ?? []) {
      const target = presentation.cells[String(targetId)];
      const xOverlap = Math.min(source.x + source.width, target.x + target.width)
        - Math.max(source.x, target.x);
      const yOverlap = Math.min(source.y + source.height, target.y + target.height)
        - Math.max(source.y, target.y);
      if (xOverlap <= GEOMETRY_EPSILON || yOverlap <= GEOMETRY_EPSILON) {
        fail(
          `presentation.cells.${sourceId}.overlapWith`,
          `declared cell ${targetId} does not overlap`,
        );
      }
    }
  }

  assertExactKeys(presentation.theme, ['colors', 'propertyBands'], 'presentation.theme');
  assertExactKeys(presentation.theme.colors, THEME_ROLES, 'presentation.theme.colors');
  for (const role of THEME_ROLES) {
    const color = presentation.theme.colors[role];
    if (color === undefined) fail(`presentation.theme.colors.${role}`, 'is required');
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) {
      fail(`presentation.theme.colors.${role}`, 'must be a hex color');
    }
  }
  assertRecord(presentation.theme.propertyBands, 'presentation.theme.propertyBands');
  for (const [token, color] of Object.entries(presentation.theme.propertyBands)) {
    if (!/^band:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) {
      fail(`presentation.theme.propertyBands.${token}`, 'must use a band token');
    }
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) {
      fail(`presentation.theme.propertyBands.${token}`, 'must be a hex color');
    }
  }
  for (const [key, placement] of placementEntries) {
    if (placement.propertyBand !== undefined) {
      const validToken = typeof placement.propertyBand === 'string'
        && /^band:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(placement.propertyBand);
      if (!validToken || !Object.hasOwn(presentation.theme.propertyBands, placement.propertyBand)) {
        fail(`presentation.cells.${key}.propertyBand`, 'must reference a declared band token');
      }
    }
  }

  if (!Array.isArray(presentation.routes)) fail('presentation.routes', 'must be an array');
  presentation.routes.forEach((route: unknown, index: number) => {
    assertRoute(route, `presentation.routes[${index}]`, canvasSize);
  });
  if (!Array.isArray(presentation.center)) fail('presentation.center', 'must be an array');
  presentation.center.forEach((decoration: any, index: number) => {
    const path = `presentation.center[${index}]`;
    if (decoration === null || typeof decoration !== 'object') fail(path, 'must be a decoration object');
    const baseKeys = ['type', 'x', 'y', 'width', 'height', 'rotation', 'role', 'zIndex', 'mobile'];
    assertRectangle(decoration, path, canvasSize);
    if (decoration.mobile !== undefined) {
      assertExactKeys(decoration.mobile, ['x', 'y', 'width', 'height'], `${path}.mobile`);
      assertRectangle(decoration.mobile, `${path}.mobile`, canvasSize);
    }
    assertLayerFields(decoration, path);
    assertThemeRole(decoration.role, `${path}.role`);
    if (decoration.type === 'panel') {
      assertExactKeys(decoration, baseKeys, path);
    } else if (decoration.type === 'text') {
      assertExactKeys(decoration, [...baseKeys, 'text', 'fitContent'], path);
      if (typeof decoration.text !== 'string' || decoration.text.trim() === '') {
        fail(`${path}.text`, 'must be a non-empty string');
      }
      if (decoration.fitContent !== undefined && typeof decoration.fitContent !== 'boolean') {
        fail(`${path}.fitContent`, 'must be a boolean');
      }
    } else if (decoration.type === 'image') {
      assertExactKeys(decoration, [...baseKeys, 'asset', 'accessibilityLabel'], path);
      assertLocalAsset(decoration.asset, `${path}.asset`, knownAssetPaths);
      assertOptionalText(decoration.accessibilityLabel, `${path}.accessibilityLabel`);
    } else {
      fail(`${path}.type`, 'must be panel, text, or image');
    }
  });
}

function assertBoard(
  pack: MapPack,
  knownModuleKeys: ReadonlySet<string>,
  requiredModuleKeys: ReadonlySet<string>,
): void {
  const cells = pack.game.board.cells;
  if (!Array.isArray(cells) || cells.length === 0) fail('game.board.cells', 'must not be empty');
  if (typeof pack.game.board.boardName !== 'string' || pack.game.board.boardName.trim() === '') {
    fail('game.board.boardName', 'must be a non-empty string');
  }
  if (pack.game.board.direction !== undefined && pack.game.board.direction !== 'clockwise') {
    fail('game.board.direction', 'must be clockwise when provided');
  }

  const cellIds = new Set<number>();
  const stationCount = cells.filter((cell) => cell.type === 'property' && cell.subtype === 'station').length;
  cells.forEach((cell, index) => {
    if (!Number.isSafeInteger(cell.id)) {
      fail(`game.board.cells[${index}].id`, 'must be a safe integer');
    }
    if (cellIds.has(cell.id)) fail(`game.board.cells[${index}].id`, 'must be unique');
    cellIds.add(cell.id);
    if (typeof cell.name !== 'string' || cell.name.trim() === '') {
      fail(`game.board.cells[${index}].name`, 'must be a non-empty string');
    }
    if (cell.type === 'module') {
      const path = `game.board.cells[${index}]`;
      assertModuleEnvelopeRef(cell.module, `${path}.module`, knownModuleKeys, requiredModuleKeys);
      if (typeof cell.cellType !== 'string' || cell.cellType.trim() === '') {
        fail(`${path}.cellType`, 'must be a non-empty string');
      }
      assertJsonPayload(cell.payload, `${path}.payload`);
      if (isWorldTourModule(cell.module)) {
        if (cell.cellType !== 'airport-branch') {
          fail(`${path}.cellType`, 'must be airport-branch for world-tour@1');
        }
        assertWorldTourAirportPayloadShape(cell.payload, `${path}.payload`);
      }
    } else if (!CORE_CELL_TYPES.has(cell.type)) {
      fail(`game.board.cells[${index}].type`, 'must be a supported core cell type');
    }
    if (cell.type === 'tax') {
      if (!isFiniteNumber(cell.amount) || cell.amount < 0) {
        fail(`game.board.cells[${index}].amount`, 'must be a finite non-negative number');
      }
    }
    if (cell.type === 'property') {
      const path = `game.board.cells[${index}]`;
      assertNonNegativeFinite(cell.price, `${path}.price`);
      if (!isFiniteNumber(cell.mortgageValue) || cell.mortgageValue < 0 || cell.mortgageValue > cell.price) {
        fail(`${path}.mortgageValue`, 'must be between 0 and price');
      }
      if (cell.subtype === 'normal') {
        assertNonNegativeFinite(cell.houseCost, `${path}.houseCost`);
        assertNonDecreasing(cell.rents, `${path}.rents`);
        if (cell.rents.length !== pack.game.config.maxHouseLevel + 1) {
          fail(`${path}.rents`, 'length must equal maxHouseLevel + 1');
        }
      } else if (cell.subtype === 'station') {
        assertNonDecreasing(cell.rents, `${path}.rents`);
        if (cell.rents.length !== stationCount) {
          fail(`${path}.rents`, 'length must equal station count');
        }
        if (cell.houseCost !== undefined) fail(`${path}.houseCost`, 'station must not define houseCost');
      } else if (cell.subtype === 'utility') {
        if (cell.rents !== undefined) fail(`${path}.rents`, 'utility must not define rents');
        if (cell.houseCost !== undefined) fail(`${path}.houseCost`, 'utility must not define houseCost');
      } else {
        fail(`${path}.subtype`, 'is not a supported property subtype');
      }
    }
  });

  const starts = cells.filter((cell) => cell.type === 'start');
  if (starts.length !== 1) fail('game.board.cells', 'must contain exactly one start cell');
  if (starts[0]!.id !== 0) fail('game.board.cells', 'start cell must have id 0');

  cells.forEach((cell, index) => {
    if (cell.nextId !== undefined && !cellIds.has(cell.nextId)) {
      fail(`game.board.cells[${index}].nextId`, 'must reference an existing cell');
    }
    if (cell.type === 'airport' && !cellIds.has(cell.branchEntryId)) {
      fail(`game.board.cells[${index}].branchEntryId`, 'must reference an existing cell');
    }
    if (cell.type === 'special' || cell.type === 'world') {
      assertEffect(
        cell.effect,
        `game.board.cells[${index}].effect`,
        cellIds,
        knownModuleKeys,
        requiredModuleKeys,
      );
    }
  });
  const lastIndex = cells.length - 1;
  if (cells[lastIndex]!.nextId === undefined) {
    fail(`game.board.cells[${lastIndex}].nextId`, 'must be explicit on the final array cell');
  }

  const cellById = new Map(cells.map((cell, index) => [cell.id, { cell, index }]));
  const nextIdOf = (id: number): number => {
    const entry = cellById.get(id)!;
    return entry.cell.nextId ?? cells[entry.index + 1]!.id;
  };
  const mainIds = new Set<number>();
  let currentId = 0;
  while (!mainIds.has(currentId)) {
    mainIds.add(currentId);
    currentId = nextIdOf(currentId);
  }
  if (currentId !== 0) fail('game.board', 'main route must return to start id 0');

  const reachableIds = new Set(mainIds);
  for (const cell of cells) {
    if (cell.type !== 'airport') continue;
    const branchIds = new Set<number>();
    currentId = cell.branchEntryId;
    while (!mainIds.has(currentId) && !branchIds.has(currentId)) {
      branchIds.add(currentId);
      reachableIds.add(currentId);
      currentId = nextIdOf(currentId);
    }
    if (!mainIds.has(currentId)) {
      fail(`game.board.cells[${cellById.get(cell.id)!.index}].branchEntryId`, 'branch must merge into the main route');
    }
  }
  for (const cell of cells) {
    if (cell.type !== 'module' || !isWorldTourModule(cell.module)) continue;
    const index = cellById.get(cell.id)!.index;
    const payloadPath = `game.board.cells[${index}].payload`;
    const payload = assertWorldTourAirportPayloadShape(cell.payload, payloadPath);
    for (const [key, value] of [
      ['outerNextId', payload.outerNextId],
      ['branchEntryId', payload.branchEntryId],
      ['mergeCellId', payload.mergeCellId],
    ] as const) {
      if (!cellIds.has(value)) fail(`${payloadPath}.${key}`, 'must reference an existing cell');
    }
    payload.branchCellIds.forEach((cellId, branchIndex) => {
      if (!cellIds.has(cellId)) {
        fail(`${payloadPath}.branchCellIds[${branchIndex}]`, 'must reference an existing cell');
      }
    });
    if (cell.nextId !== payload.outerNextId) {
      fail(`${payloadPath}.outerNextId`, 'must equal the airport cell nextId');
    }
    if (!mainIds.has(cell.id) || !mainIds.has(payload.outerNextId)) {
      fail(payloadPath, 'airport and outer successor must belong to the main route');
    }

    const actualBranchIds: number[] = [];
    const seenBranchIds = new Set<number>();
    currentId = payload.branchEntryId;
    while (!mainIds.has(currentId) && !seenBranchIds.has(currentId)) {
      seenBranchIds.add(currentId);
      actualBranchIds.push(currentId);
      currentId = nextIdOf(currentId);
    }
    if (seenBranchIds.has(currentId)) {
      fail(`${payloadPath}.branchCellIds`, 'branch route must merge into the main route');
    }
    if (currentId !== payload.mergeCellId) {
      fail(`${payloadPath}.mergeCellId`, 'must equal the branch route merge cell');
    }
    if (
      actualBranchIds.length !== payload.branchCellIds.length
      || actualBranchIds.some((cellId, branchIndex) => cellId !== payload.branchCellIds[branchIndex])
    ) {
      fail(`${payloadPath}.branchCellIds`, 'must match the exact ordered branch route');
    }
    actualBranchIds.forEach((cellId) => reachableIds.add(cellId));
  }
  const unreachable = cells.find((cell) => !reachableIds.has(cell.id));
  if (unreachable !== undefined) fail('game.board', `cell ${unreachable.id} is unreachable`);

  const cardIds = new Set<string>();
  assertExactKeys(pack.game.cards, ['chance', 'destiny'], 'game.cards');
  for (const deckName of ['chance', 'destiny'] as const) {
    if (!Array.isArray(pack.game.cards[deckName])) {
      fail(`game.cards.${deckName}`, 'must be an array');
    }
  }
  for (const deckName of ['chance', 'destiny'] as const) {
    const cards = pack.game.cards[deckName];
    cards.forEach((card, index) => {
      const path = `game.cards.${deckName}[${index}]`;
      if (typeof card.id !== 'string' || card.id.trim() === '') fail(`${path}.id`, 'must be non-empty');
      if (cardIds.has(card.id)) fail(`${path}.id`, 'must be globally unique');
      cardIds.add(card.id);
      assertOptionalText(card.title, `${path}.title`);
      if (typeof card.text !== 'string' || card.text.trim() === '') {
        fail(`${path}.text`, 'must be a non-empty string');
      }
      assertEffect(
        card.effect,
        `game.cards.${deckName}[${index}].effect`,
        cellIds,
        knownModuleKeys,
        requiredModuleKeys,
      );
    });
  }
}

export function assertValidMapPack(
  value: unknown,
  knownRuleModules: readonly RuleModuleRef[],
  knownAssetPaths: readonly string[] = [],
): void {
  canonicalStringify(value);
  assertMapPackStructure(value);
  const pack = value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack.ref.id)) {
    fail('ref.id', 'must be a lowercase slug');
  }
  if (!Number.isSafeInteger(pack.ref.version) || pack.ref.version <= 0) {
    fail('ref.version', 'must be a positive integer');
  }
  if (!/^[0-9a-f]{64}$/.test(pack.ref.contentHash)) {
    fail('ref.contentHash', 'must be 64 lowercase hexadecimal characters');
  }
  for (const field of ['title', 'description'] as const) {
    if (typeof pack.metadata[field] !== 'string' || pack.metadata[field].trim() === '') {
      fail(`metadata.${field}`, 'must be a non-empty string');
    }
  }

  const knownModuleKeys = new Set(knownRuleModules.map(({ id, version }) => `${id}@${version}`));
  const requiredModuleKeys = new Set<string>();
  pack.game.requiredRuleModules.forEach((module, index) => {
    const path = `game.requiredRuleModules[${index}]`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(module.id)) {
      fail(`${path}.id`, 'must be a lowercase slug');
    }
    if (!Number.isSafeInteger(module.version) || module.version <= 0) {
      fail(`${path}.version`, 'must be a positive integer');
    }
    const key = `${module.id}@${module.version}`;
    if (requiredModuleKeys.has(key)) fail(path, `duplicate rule module ${key}`);
    if (!knownModuleKeys.has(key)) fail(path, `unknown rule module ${key}`);
    requiredModuleKeys.add(key);
  });
  if (!requiredModuleKeys.has('core@1')) {
    fail('game.requiredRuleModules', 'must include core@1');
  }
  assertConfig(pack);
  assertBoard(pack, knownModuleKeys, requiredModuleKeys);
  assertPresentation(pack, new Set(knownAssetPaths));
  if (computeContentHash(pack) !== pack.ref.contentHash) {
    fail('ref.contentHash', 'does not match canonical map content');
  }
}
