import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveMapPack } from '@richman/board-data';
import type { PublicRoomSummary } from '@richman/protocol';
import type { PendingRoomRequest } from '../session/sessionStorage';
import OnlineEntryView from './OnlineEntryView.vue';
import { renderView } from './viewTestSupport';

const here = dirname(fileURLToPath(import.meta.url));
const chinaMapPack = getActiveMapPack('china-tour');

function renderEntry(props: Record<string, unknown> = {}): Promise<string> {
  return renderView(OnlineEntryView, { activeMaps: [chinaMapPack], ...props });
}

const pendingCreate: PendingRoomRequest = {
  operation: 'create',
  requestId: '0123456789abcdef0123456789abcdef',
  nickname: '房主',
  mapId: 'china-tour',
};

const joinableRoom: PublicRoomSummary = {
  roomCode: '000007',
  hostNickname: '房主甲',
  mapTitle: chinaMapPack.metadata.title,
  status: 'lobby',
  playerCount: 2,
  spectatorCount: 0,
  playerLimit: 6,
  spectatorLimit: 3,
  joinable: true,
  spectatable: true,
  turnTimeLimitSec: 60,
  botDifficulty: 'normal',
  hasPassword: false,
  allowSpectators: true,
};

describe('OnlineEntryView join role', () => {
  it('shows an explicit spectator join choice without auto-submitting', async () => {
    const html = await renderEntry();
    expect(html).toContain('aria-label="加入身份"');
    expect(html).toContain('参赛');
    expect(html).toContain('观战');
    expect(html).toContain('加入房间');
    expect(html).toContain('输入好友分享的 6 位房间码');
  });
});

/**
 * 页顶那个「一键开房」（2026-10-16 用户拍板）。
 *
 * 建房只强制两件输入（昵称 + 地图），两者都有默认值 ⇒ 没有非问不可的字段。
 * 把玩家送到这一页之后**还逼他填表再按一次**，正是这条路走过一次的倒退：
 * 所以页顶这个大按钮就是「进来就能开」，完整的昵称 / 地图 / 创建房间表单留在下面供改。
 */
describe('OnlineEntryView 一键开房', () => {
  it('按钮上写着「一键开房」，且排在完整表单与公开房间列表之前', async () => {
    const html = await renderEntry();

    expect(html).toContain('一键开房');
    expect(html.indexOf('一键开房')).toBeLessThan(html.indexOf('id="home-form"'));
    expect(html.indexOf('一键开房')).toBeLessThan(html.indexOf('class="home-rooms"'));
  });

  it('完整表单一个入口都没少：昵称、地图、创建房间、房间码、房间密码、身份', async () => {
    const html = await renderEntry();

    expect(html).toContain('你的昵称');
    expect(html).toContain('创建房间');
    expect(html).toContain('房间码');
    expect(html).toContain('房间密码');
  });

  it('页顶大按钮绑的是 quickCreate，不是「滚到表单」', () => {
    const source = readFileSync(resolve(here, 'OnlineEntryView.vue'), 'utf8');
    const tag = /<button[^>]*home-main--online[^>]*>/.exec(source);
    if (tag === null) throw new Error('在线对战页应当有一个 home-main--online 按钮');

    expect(tag[0]).toContain('@click="quickCreate"');
    // 只有「一张可选地图都没有」时才回落到表单，那个兜底叫 jumpToForm。
    expect(source).not.toContain('jumpToOnlineForm');
  });
});

/**
 * 两块「续上一局」提示（#23 / 待续请求）。
 *
 * 它们跟着**来源**走：都是联机的续玩入口，于是落到本页顶部，不再和首页别的内容抢位置。
 * 首页瘦成导航图之后，这一层落点尤其要紧 —— 提示要是没地方挂，一个「待续请求还在、
 * 界面却一字不提」的玩家就再也没有路径回到自己那局。
 */
describe('OnlineEntryView 续上一局', () => {
  it('「你还有一局进行中」与「上次操作未完成」都落在页顶，排在表单之前', async () => {
    const html = await renderEntry({ canResumeActive: true, resume: pendingCreate });

    expect(html).toContain('你还有一局进行中');
    expect(html).toContain('上次操作未完成');
    expect(html).toContain('继续创建房间（房主）');
    expect(html.indexOf('你还有一局进行中')).toBeLessThan(html.indexOf('id="home-form"'));
    expect(html.indexOf('上次操作未完成')).toBeLessThan(html.indexOf('id="home-form"'));
  });

  it('待续请求判定为「不可能成功」时不再给「继续」，只留放弃', async () => {
    const html = await renderEntry({ resume: pendingCreate, pendingRetryable: false });

    expect(html).toContain('该房间已无法进入，请放弃后重新开始。');
    expect(html).toContain('放弃上次操作');
    expect(html).not.toContain('继续上次操作');
  });

  it('没有可续的东西时，两块提示整段不渲染', async () => {
    const html = await renderEntry();

    expect(html).not.toContain('你还有一局进行中');
    expect(html).not.toContain('上次操作未完成');
  });
});

/**
 * 公开房间列表与「一键旁观」（路线图 #108）。
 *
 * 列表是一条**只读投影**：能不能加入 / 能不能旁观由服务端算好的
 * `joinable` / `spectatable` 决定，客户端只负责把这两个布尔如实画成按钮状态。
 * 所以这里断言的重点是「服务端说不行的，按钮必须真的是灰的」——
 * 灰按钮比点下去才报错的按钮好得多，也比偷偷把按钮藏起来好（用户会以为是空的）。
 *
 * 位置也是一条决策（《UI 改造方案》§六）：**默认展开**，紧跟房间码输入框下方 ——
 * 它本来就是「加入房间」的第二种填法。
 */
describe('OnlineEntryView public room list', () => {
  it('lists a discoverable room with its code, status, seats and the join / spectate actions', async () => {
    const html = await renderEntry({ publicRooms: [joinableRoom] });

    expect(html).toContain('公开房间');
    expect(html).toContain('000007');
    expect(html).toContain('大厅等待中');
    expect(html).toContain(chinaMapPack.metadata.title);
    expect(html).toContain('2/6 人');
    // 限时（#107）顺手标在列表上：不限时的房间不该显示这一截。
    expect(html).toContain('每步 60 秒');
    expect(html).toContain('加入');
    expect(html).toContain('旁观');
  });

  it('默认展开，且落在房间码输入框下方', async () => {
    const html = await renderEntry({ publicRooms: [joinableRoom] });

    // 内容直接可见 ⇒ 不是藏在折叠块里的；位置在提示行之后。
    expect(html).toContain('000007');
    expect(html.indexOf('id="home-room-hint"')).toBeLessThan(html.indexOf('class="home-rooms"'));
  });

  it('greys out the seats the server already ruled out instead of hiding the room', async () => {
    const html = await renderEntry({
      publicRooms: [
        { ...joinableRoom, status: 'playing', spectatorCount: 3, joinable: false, spectatable: false },
      ],
    });

    expect(html).toContain('对局进行中');
    expect(html).toContain('这局已经开局或人数已满，只能旁观');
    expect(html).toContain('观战位已满');
    expect(html).toContain('2/6 人 · 观战 3');
  });

  it('shows the refresh failure rather than pretending the list is empty', async () => {
    const html = await renderEntry({ publicRooms: [], roomListError: '房间列表加载失败，请重试' });

    expect(html).toContain('房间列表加载失败，请重试');
    // 空态文案是给「确实没人公开」用的；加载失败时说出来会让玩家以为房间里真的没人。
    expect(html).not.toContain('现在没有公开的房间');
  });

  it('falls back to an empty-state hint when nothing is published', async () => {
    const html = await renderEntry({ publicRooms: [] });

    expect(html).toContain('现在没有公开的房间');
    // 空态也要把「房间码仍可用」说清楚，否则玩家会以为只能从列表进房。
    expect(html).toContain('输入房间码可以直接加入好友的房');
  });
});
