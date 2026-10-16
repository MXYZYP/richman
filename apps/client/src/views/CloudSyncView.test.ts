import { describe, expect, it } from 'vitest';
import CloudSyncView from './CloudSyncView.vue';
import { renderView, withLocalStorage } from './viewTestSupport';

/**
 * 「云同步」详情页（《UI 改造方案》§四 + 其后的尾注）。
 *
 * 认这块 UI 一律用**结构标记**（class / placeholder），不用中文文案 —— 理由与排行榜那条相同：
 * 更新说明正文本来就会写到「云同步」「恢复码」。拿文案当标记，区块真被删掉时
 * 「该出现」那条照样绿，两条方向相反的断言会同时失去判别力。
 *
 * 这一页还刻意**不随本机存储隐藏**（与原来挂在首页战绩区块里时相反）：
 * 它是唯一会给服务器发数据的操作，独立成页的意义就在于把「上传了什么、不传什么」讲清楚；
 * 存储不可用时该说的是「同步失败」，而不是让整页凭空消失。
 */
function renderCloud(): Promise<string> {
  return renderView(CloudSyncView, { open: true });
}

describe('CloudSyncView 云同步（#123）', () => {
  it('给出恢复码账号的入口，并把「恢复码长什么样」写在输入框上', async () => {
    const html = await withLocalStorage(renderCloud);

    expect(html).toContain('class="cloud-sync"');
    expect(html).toContain('class="cloud-sync-title"');
    // placeholder 是玩家唯一能看到「恢复码格式」的地方：没有它，手抄来的码该不该带横线只能靠猜，
    // 而猜错的代价是一次必然失败的往返。
    expect(html).toContain('placeholder="RM-XXXX-XXXX-XXXX-XXXX-XXXX"');
    expect(html).toContain('class="cloud-sync-input"');
    // 未绑定时不该出现「换一段恢复码」「退出云同步」——它们只对已绑定的账号有意义。
    expect(html).not.toContain('cloud-sync-button-ghost');
  });

  it('未绑定时不渲染空的恢复码展示区与空提示条', async () => {
    const html = await withLocalStorage(renderCloud);

    // `cloudNewCode` / `cloudNotice` 初值是空串 / null：两块必须整段不渲染，
    // 否则页面上会挂一个空的 <code> 和一个空的提示条。
    expect(html).not.toContain('class="cloud-sync-code"');
    expect(html).not.toContain('class="cloud-sync-notice"');
  });

  it('把隐私取舍与保留期写在伸手可及的地方', async () => {
    const html = await withLocalStorage(renderCloud);

    // 这两句是玩家敢不敢按下去的根据：不自动联网、以及云端到底会留多久。
    expect(html).toContain('只有你按下按钮时才会发请求');
    expect(html).toContain('云端的账号一年没有同步过会被清理');
  });

  it('浏览器不给本地存储时弹窗照样可达 —— 弹窗外壳与说明都在，不留空白', async () => {
    // node 环境本来就没有 localStorage：这里读到的就是「无存储」。
    const html = await renderCloud();

    expect(html).toContain('data-variant="modal"');
    expect(html).toContain('class="cloud-sync"');
    expect(html).toContain('这台设备还没有绑定云端账号');
  });
});
