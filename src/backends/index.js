// 多后端工厂：根据 config.backend.type 创建对应的 Agent 运行时客户端
import { NodeApiClient } from '../dsh-client.js';
import { AgyApiClient } from './agy-client.js';

export const SUPPORTED_BACKENDS = Object.freeze(['dsh', 'agy']);

/** 校验并规范化后端类型 */
export function normalizeBackendType(raw) {
  const value = String(raw ?? 'dsh').trim().toLowerCase() || 'dsh';
  if (!SUPPORTED_BACKENDS.includes(value)) {
    throw new Error(`配置 backend.type 非法：${JSON.stringify(raw)}（当前支持：${SUPPORTED_BACKENDS.join(' / ')}）`);
  }
  return value;
}

/** 根据配置创建后端客户端实例 */
export function createBackendClient(cfg, { rootDir, stateDir, log } = {}) {
  const type = normalizeBackendType(cfg?.backend?.type);
  if (type === 'agy') {
    const agyCfg = cfg?.backend?.agy ?? {};
    return new AgyApiClient({
      ...agyCfg,
      rootDir,
      stateDir,
      log,
    });
  }
  const client = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    allowRemote: cfg.dsh.allowRemote === true,
  });
  client.backendType = 'dsh';
  client.backendLabel = 'DSH';
  client.supportsPortDiscovery = true;
  return client;
}
