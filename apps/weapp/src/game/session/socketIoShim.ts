/**
 * socket.io 驱动的小程序替身。
 *
 * 源站 session/onlineSession.ts 只在一处真正碰传输层：`io(url)`。
 * 其余全是 socket 实例的 on/off/emit。
 *
 * 小程序没有 WebSocket 全局对象、也没有 XMLHttpRequest，socket.io-client 的
 * engine 层直接不可用。这里给一个「永不连上」的 socket：
 *   - 结构完整，源站的会话状态机可以照常构造与销毁；
 *   - 一旦尝试连接就触发 connect_error，上层据此走既有的失败提示，
 *     而不是白屏。
 *
 * 真要做联机，需要服务端加原生 WebSocket 端点 + 这里换成 wx.connectSocket，
 * 属于独立一期。
 */
type Handler = (...args: unknown[]) => void;

export type Socket<ListenEvents = Record<string, unknown>, EmitEvents = Record<string, unknown>> = {
  connected: boolean;
  id: string | undefined;
  on: (event: string, handler: Handler) => Socket<ListenEvents, EmitEvents>;
  off: (event?: string, handler?: Handler) => Socket<ListenEvents, EmitEvents>;
  emit: (event: string, ...args: unknown[]) => Socket<ListenEvents, EmitEvents>;
  connect: () => Socket<ListenEvents, EmitEvents>;
  disconnect: () => Socket<ListenEvents, EmitEvents>;
  removeAllListeners: () => Socket<ListenEvents, EmitEvents>;
  timeout: (ms: number) => { emit: (event: string, ...args: unknown[]) => void };
};

export function io(_url?: unknown, _options?: unknown): Socket {
  const handlers = new Map<string, Set<Handler>>();

  const fire = (event: string, ...args: unknown[]) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  const socket: Socket = {
    connected: false,
    id: undefined,
    on(event, handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return socket;
    },
    off(event, handler) {
      if (event === undefined) {
        handlers.clear();
        return socket;
      }
      if (handler === undefined) handlers.delete(event);
      else handlers.get(event)?.delete(handler);
      return socket;
    },
    emit() {
      // 未连接时发出去的包直接丢弃：与 socket.io 的离线缓冲语义一致，
      // 区别只是这里永远不会真的发出去。
      return socket;
    },
    connect() {
      // 延后一拍再报错，让调用方先把监听装好（源站是先 on 再 connect）。
      setTimeout(() => {
        fire('connect_error', new Error('小程序版暂不支持联机对战'));
        fire('disconnect', 'transport error');
      }, 0);
      return socket;
    },
    disconnect() {
      return socket;
    },
    removeAllListeners() {
      handlers.clear();
      return socket;
    },
    timeout() {
      return {
        emit: (event: string, ...args: unknown[]) => {
          // socket.io 的 ack 回调是最后一个参数。
          const ack = args[args.length - 1];
          if (typeof ack === 'function') {
            setTimeout(() => (ack as Handler)(new Error('小程序版暂不支持联机对战')), 0);
          }
          void event;
        },
      };
    },
  };

  return socket;
}
