/**
 * 服务端实时指标（运营 O2）。
 *
 * 与埋点（O0）分工：**埋点回答「过去一段时间怎么样」，这个端点回答「此刻怎么样」**。
 * 部署核验尤其需要后者 —— 光看 `/healthz` 返回 200 只能证明「有进程在听 3000 端口」，
 * 证明不了「这个进程是刚部署的那个」（孤儿进程同样能答 /healthz）。
 * 有一个只有新代码才有的端点，核验才有了可探测的新行为。
 *
 * 刻意只暴露**聚合数字**：房间数、在线人数、进行中房间数、进程运行时长、掉线/重连计数。
 * 没有房间码、没有昵称、没有 IP —— 这是给运维与部署核验用的，不是给外人看的房间目录。
 */

export interface RoomStats {
  /** 内存里的房间总数（含已结束但尚未清理的）。 */
  readonly rooms: number;
  /** 标记为在线的玩家总数（掉线中的不计）。 */
  readonly players: number;
  /** 正在进行对局的房间数（`status === 'playing'`）。 */
  readonly playing: number;
}

export interface ServerMetrics extends RoomStats {
  /** 进程启动至今的秒数。 */
  readonly uptimeSeconds: number;
  /** 进程启动时刻（ISO）。 */
  readonly startedAt: string;
  /** 自启动以来的断线次数（socket 断开且该连接确实绑着房间里的玩家）。 */
  readonly disconnects: number;
  /** 自启动以来的重连成功次数（`session:resume` 成功）。 */
  readonly reconnects: number;
}

export interface MetricsCollector {
  snapshot(): ServerMetrics;
  /** socket 断开：由 adapter 在 `handleDisconnect` 里调。 */
  recordDisconnect(): void;
  /** 重连成功：由 adapter 在 `session:resume` 成功后调。 */
  recordReconnect(): void;
}

export interface ServerMetricsDeps {
  /** 实时房间统计的来源（`RoomManager.stats()`）。 */
  rooms: () => RoomStats;
  now?: () => number;
}

export function createServerMetrics(deps: ServerMetricsDeps): MetricsCollector {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  let disconnects = 0;
  let reconnects = 0;

  return {
    snapshot() {
      const rooms = deps.rooms();
      const at = now();
      return {
        ...rooms,
        uptimeSeconds: Math.max(0, Math.round((at - startedAtMs) / 1000)),
        startedAt: new Date(startedAtMs).toISOString(),
        disconnects,
        reconnects,
      };
    },

    recordDisconnect() {
      disconnects += 1;
    },

    recordReconnect() {
      reconnects += 1;
    },
  };
}
