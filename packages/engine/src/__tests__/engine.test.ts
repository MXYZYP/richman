import { describe, it, expect } from 'vitest';

// M1 占位测试：确认 Vitest 配置生效、engine 包测试能跑
// M2 起这里放真正的规则测试（E01-E24）
describe('engine package (M1 scaffold)', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });
});
