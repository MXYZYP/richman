import { describe, expect, it } from 'vitest';
import { canonicalStringify, computeContentHash, sha256Hex } from '../hash';
import type { MapPack } from '../mapTypes';

function makeMapPack(overrides: {
  readonly id?: string;
  readonly version?: number;
  readonly contentHash?: string;
  readonly title?: string;
  readonly boardName?: string;
  readonly initialCash?: number;
  readonly moduleVersion?: number;
  readonly cellX?: number;
  readonly boardColor?: string;
} = {}): MapPack {
  return {
    ref: {
      id: overrides.id ?? 'minimal-map',
      version: overrides.version ?? 1,
      contentHash: overrides.contentHash ?? 'placeholder',
    },
    metadata: {
      title: overrides.title ?? '最小地图',
      description: '用于 content hash 测试',
    },
    game: {
      board: {
        boardName: overrides.boardName ?? '最小棋盘',
        direction: 'clockwise',
        cells: [{ id: 0, type: 'start', name: '起点', nextId: 0 }],
      },
      cards: {
        chance: [],
        destiny: [],
      },
      config: {
        initialCash: overrides.initialCash ?? 15_000,
        passStartSalary: 2_000,
        maxHouseLevel: 5,
        sellHouseRefundRate: 0.5,
        sellLandRate: 0.5,
        mortgageInterestRate: 0.1,
        utilityMultipliers: [4, 10],
        jailExitMinRoll: 4,
        jailMaxAttempts: 3,
        cashGoalPresets: [50_000],
        diceMode: 'two_dice',
        airportBranchDice: 1,
        jailEnabled: true,
      },
      requiredRuleModules: [{ id: 'core', version: overrides.moduleVersion ?? 1 }],
    },
    presentation: {
      canvas: { size: 100 },
      cells: {
        0: {
          x: overrides.cellX ?? 0,
          y: 0,
          width: 10,
          height: 10,
          shortLabel: '起点',
        },
      },
      routes: [],
      center: [],
      theme: {
        colors: {
          board: overrides.boardColor ?? '#ffffff',
          cell: '#f8f8f8',
          border: '#111111',
          route: '#222222',
          title: '#333333',
          decoration: '#444444',
          center: '#eeeeee',
        },
        propertyBands: {},
      },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

describe('canonicalStringify', () => {
  it('不受 object key 插入顺序影响，并递归排序 nested object', () => {
    const first = {
      z: 1,
      nested: { b: 2, a: 1 },
      a: 0,
    };
    const second = {
      a: 0,
      nested: { a: 1, b: 2 },
      z: 1,
    };

    expect(canonicalStringify(first)).toBe(canonicalStringify(second));
    expect(canonicalStringify(first)).toBe('{"a":0,"nested":{"a":1,"b":2},"z":1}');
  });

  it('按 Unicode code-unit 顺序排列 key', () => {
    expect(canonicalStringify({ '\uE000': 2, '😀': 1 })).toBe('{"😀":1,"":2}');
  });

  it('保留 array order', () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });

  it('使用标准 JSON string escaping', () => {
    const value = '"\\\b\f\n\r\t\u0000';

    expect(canonicalStringify(value)).toBe(JSON.stringify(value));
    expect(canonicalStringify(value)).toContain('\\"\\\\\\b\\f\\n\\r\\t\\u0000');
  });

  it('把 -0 规范化为 0', () => {
    expect(canonicalStringify(-0)).toBe('0');
    expect(canonicalStringify({ value: -0 })).toBe('{"value":0}');
  });

  it.each([
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['bigint', 1n],
  ])('拒绝 %s value', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(/unsupported value/i);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('拒绝非有限数字 %s', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(/finite number/i);
  });

  it('拒绝 sparse array', () => {
    expect(() => canonicalStringify(new Array(1))).toThrow(/sparse array/i);
  });

  it('拒绝 symbol-key', () => {
    const value = { ordinary: true, [Symbol('hidden')]: false };

    expect(() => canonicalStringify(value)).toThrow(/symbol key/i);
  });

  it.each([
    ['getter', Object.defineProperty({}, 'value', { get: () => 1, enumerable: true })],
    ['setter', Object.defineProperty({}, 'value', { set: () => undefined, enumerable: true })],
  ])('拒绝 %s property', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(/accessor/i);
  });

  it.each([
    ['undefined value', Object.defineProperty({}, 'bad', { value: undefined })],
    ['ordinary value', Object.defineProperty({}, 'hidden', { value: 1 })],
  ])('拒绝 plain object 的 non-enumerable property：%s', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(/non-enumerable property/i);
  });

  it('拒绝 array 的额外 string property', () => {
    const value = [1] as unknown[] & { bad?: unknown };
    value.bad = undefined;

    expect(() => canonicalStringify(value)).toThrow(/unexpected array property/i);
  });

  it('拒绝 array 通过额外 property 形成的 self-reference', () => {
    const value = [] as unknown[] & { self?: unknown };
    value.self = value;

    expect(() => canonicalStringify(value)).toThrow(/unexpected array property/i);
  });

  class ExampleClass {
    readonly value = 1;
  }

  it.each([
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['class instance', new ExampleClass()],
  ])('拒绝非 plain object：%s', (_label, value) => {
    expect(() => canonicalStringify(value)).toThrow(/plain object/i);
  });

  it('拒绝 cycle', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => canonicalStringify(value)).toThrow(/cycle/i);
  });

  it('允许同一 object 在非循环位置重复引用', () => {
    const shared = { value: 1 };

    expect(canonicalStringify({ first: shared, second: shared })).toBe(
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });
});

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('计算已知 SHA-256 vector：%j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it.each([
    [55, '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
    [56, 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
    [64, 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    [65, '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0'],
  ])('跨 padding/block 边界：%i bytes', (length, expected) => {
    expect(sha256Hex('a'.repeat(length))).toBe(expected);
  });

  it('计算标准 multi-block vector', () => {
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('按 UTF-8 计算中文和 emoji', () => {
    expect(sha256Hex('地图😀')).toBe(
      '53885141b36589c1f4f9b4eb25f2e216995ef7accb1dd2c0e9066de4231563aa',
    );
  });
});

describe('computeContentHash', () => {
  it('只忽略 ref.contentHash 本身', () => {
    const initial = computeContentHash(makeMapPack({ contentHash: 'placeholder' }));

    expect(computeContentHash(makeMapPack({ contentHash: 'stale-hash' }))).toBe(initial);
  });

  it('不访问被忽略的 ref.contentHash accessor', () => {
    const pack = makeMapPack();
    let accessed = false;
    Object.defineProperty(pack.ref, 'contentHash', {
      enumerable: true,
      get: () => {
        accessed = true;
        throw new Error('contentHash getter must not run');
      },
    });

    expect(computeContentHash(pack)).toBe(computeContentHash(makeMapPack()));
    expect(accessed).toBe(false);
  });

  it('拒绝额外 own enumerable 顶层字段', () => {
    const pack = makeMapPack();
    const extendedPack = { ...pack, futureField: 'future-value' };

    expect(() => computeContentHash(extendedPack)).toThrow(/unexpected MapPack property/i);
  });

  it('拒绝 ref 中额外 own enumerable 字段', () => {
    const pack = makeMapPack();
    const extendedPack = { ...pack, ref: { ...pack.ref, futureField: 'future-value' } };

    expect(() => computeContentHash(extendedPack)).toThrow(/unexpected MapRef property/i);
  });

  it('拒绝顶层和 ref 中额外 non-enumerable 字段', () => {
    const topLevelExtra = makeMapPack();
    Object.defineProperty(topLevelExtra, 'futureField', { value: 'future-value' });
    const refExtra = makeMapPack();
    Object.defineProperty(refExtra.ref, 'futureField', { value: 'future-value' });

    expect(() => computeContentHash(topLevelExtra)).toThrow(/non-enumerable property/i);
    expect(() => computeContentHash(refExtra)).toThrow(/non-enumerable property/i);
  });

  it('拒绝缺少批准顶层或 ref 字段的输入', () => {
    const { presentation: _presentation, ...missingPresentation } = makeMapPack();
    const pack = makeMapPack();
    const { id: _id, ...missingId } = pack.ref;

    expect(() => computeContentHash(missingPresentation as unknown as MapPack)).toThrow(
      /missing MapPack property presentation/i,
    );
    expect(() => computeContentHash({ ...pack, ref: missingId } as unknown as MapPack)).toThrow(
      /missing MapRef property id/i,
    );
  });

  it('拒绝额外 accessor 且不触发 getter', () => {
    const pack = makeMapPack();
    let accessed = false;
    Object.defineProperty(pack, 'futureField', {
      enumerable: true,
      get: () => {
        accessed = true;
        return 'future-value';
      },
    });

    expect(() => computeContentHash(pack)).toThrow(/accessor/i);
    expect(accessed).toBe(false);
  });

  it('拒绝批准字段 accessor 且不触发 getter', () => {
    const topLevelAccessor = makeMapPack();
    const refAccessor = makeMapPack();
    let topLevelAccessed = false;
    let refAccessed = false;
    Object.defineProperty(topLevelAccessor, 'metadata', {
      enumerable: true,
      get: () => {
        topLevelAccessed = true;
        return makeMapPack().metadata;
      },
    });
    Object.defineProperty(refAccessor.ref, 'id', {
      enumerable: true,
      get: () => {
        refAccessed = true;
        return 'minimal-map';
      },
    });

    expect(() => computeContentHash(topLevelAccessor)).toThrow(/accessor/i);
    expect(() => computeContentHash(refAccessor)).toThrow(/accessor/i);
    expect(topLevelAccessed).toBe(false);
    expect(refAccessed).toBe(false);
  });

  it('拒绝额外 symbol-key', () => {
    const pack = makeMapPack();
    Object.defineProperty(pack, Symbol('futureField'), { value: 'future-value', enumerable: true });
    const refPack = makeMapPack();
    Object.defineProperty(refPack.ref, Symbol('futureField'), {
      value: 'future-value',
      enumerable: true,
    });

    expect(() => computeContentHash(pack)).toThrow(/symbol key/i);
    expect(() => computeContentHash(refPack)).toThrow(/symbol key/i);
  });

  it.each([
    ['ref.id', { id: 'another-map' }],
    ['ref.version', { version: 2 }],
    ['metadata', { title: '另一张地图' }],
    ['game.board', { boardName: '另一块棋盘' }],
    ['game.config', { initialCash: 20_000 }],
    ['requiredRuleModules', { moduleVersion: 2 }],
    ['presentation geometry', { cellX: 1 }],
    ['presentation theme', { boardColor: '#000000' }],
  ])('修改 %s 会改变 hash', (_label, overrides) => {
    expect(computeContentHash(makeMapPack(overrides))).not.toBe(computeContentHash(makeMapPack()));
  });

  it('返回 64 位 lowercase hex', () => {
    expect(computeContentHash(makeMapPack())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不修改输入 MapPack', () => {
    const pack = makeMapPack();
    const before = JSON.stringify(pack);

    computeContentHash(pack);

    expect(JSON.stringify(pack)).toBe(before);
  });

  it('接受递归 frozen MapPack 并保留值', () => {
    const pack = deepFreeze(makeMapPack());
    const expected = computeContentHash(makeMapPack());

    expect(computeContentHash(pack)).toBe(expected);
    expect(pack.ref.contentHash).toBe('placeholder');
    expect(pack.game.board.cells[0]?.name).toBe('起点');
    expect(Object.isFrozen(pack.game.board.cells[0])).toBe(true);
  });
});
