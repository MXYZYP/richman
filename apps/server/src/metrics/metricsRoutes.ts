import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseRequestUrl, respondJson } from '../http/httpJson';
import type { MetricsCollector } from './serverMetrics';

/**
 * `GET /api/metrics`（运营 O2 / 部署核验）。
 *
 * 与 `/healthz` 的区别：`/healthz` 只答「进程活着」，这个端点答「**这个**进程活着，
 * 而且它知道现在有几间房、跑了多久」。部署核验要的是后者，见 `serverMetrics.ts` 文件头。
 *
 * 只支持 GET，且**不挂在限流后面**：它是被 CI 与运维高频打的那个端点，
 * 限流只会让部署核验在闲时被自己挡住；它不写任何数据，也没有可滥用的资源。
 */

export const METRICS_PATH = '/api/metrics';

export interface MetricsApiOptions {
  collector: MetricsCollector;
}

/** 返回 `true` = 这个请求已被本模块处理完毕；`false` = 交给后续处理器。 */
export type MetricsApiHandler = (request: IncomingMessage, response: ServerResponse) => boolean;

export function createMetricsApi(options: MetricsApiOptions): MetricsApiHandler {
  const { collector } = options;

  return (request, response) => {
    const url = parseRequestUrl(request.url);
    if (url === null || url.pathname !== METRICS_PATH) return false;

    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      respondJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    respondJson(response, 200, { ok: true, ...collector.snapshot() });
    return true;
  };
}
