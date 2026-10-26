import { describe, expect, it } from 'vitest';
import { resolveServerOrigin } from './serverOrigin';

describe('resolveServerOrigin', () => {
  it('同源部署：没配就返回空串（相对路径继续可用）', () => {
    expect(resolveServerOrigin(undefined)).toBe('');
    expect(resolveServerOrigin({})).toBe('');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: '' })).toBe('');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: '   ' })).toBe('');
  });

  it('跨域部署：返回去掉结尾斜杠的绝对地址', () => {
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'https://game.mxyzyp.xyz' })).toBe('https://game.mxyzyp.xyz');
    // 结尾多写斜杠是常见手误，拼接口时会变成 //api，这里统一收掉
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'https://game.mxyzyp.xyz/' })).toBe('https://game.mxyzyp.xyz');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'https://game.mxyzyp.xyz///' })).toBe('https://game.mxyzyp.xyz');
  });

  it('带路径前缀也照原样保留（子目录反向代理场景）', () => {
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'https://game.mxyzyp.xyz/richman' })).toBe('https://game.mxyzyp.xyz/richman');
  });

  it('写错格式宁可当没配，也不要拼出相对串', () => {
    // 漏了协议：若原样返回，fetch('game.mxyzyp.xyz/api/leaderboard') 会被当成站内路径，
    // 报出来的错误跟真实原因毫无关系，排查成本极高。
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'game.mxyzyp.xyz' })).toBe('');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: '//game.mxyzyp.xyz' })).toBe('');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'ftp://game.mxyzyp.xyz' })).toBe('');
  });

  it('允许端口号与 localhost（本地联调）', () => {
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'http://127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
    expect(resolveServerOrigin({ VITE_SERVER_ORIGIN: 'http://localhost:4173/' })).toBe('http://localhost:4173');
  });
});
