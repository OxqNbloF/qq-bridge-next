// 需要的公共东西都放在这里，模块从这里取
import path from 'node:path';

/** 由仓库根推导 state/ 下各文件路径 */
export function statePaths(root) {
  const state = path.join(root, 'state');
  return Object.freeze({
    root,
    state,
    config: path.join(root, 'config.json'),
    sessions: path.join(state, 'sessions.json'),
    socialV2: path.join(state, 'social-v2.json'),
    initialPrompts: path.join(state, 'initial-prompts.json'),
    roleInject: path.join(state, 'role-inject.json'),
    currentRole: path.join(state, 'current-role.json'),
    archive: path.join(state, 'archive'),
    views: path.join(state, 'views'),
    index: path.join(state, 'index'),
    compressCursors: path.join(state, 'pool', 'cursors.json'),
  });
}

/**
 * 创建共享信息：仓库根、实时配置、路径和存储
 * @param {object} opts
 * @param {string} opts.root  仓库根目录
 * @param {object} opts.cfg   配置，会被控制台热更新
 * @param {(...a:any[]) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
export function createAppContext({ root, cfg, log = () => {}, now = () => Date.now() }) {
  if (!root) throw new Error('createAppContext: 缺少 root');
  if (!cfg || typeof cfg !== 'object') throw new Error('createAppContext: 缺少 cfg');
  const stores = Object.create(null);
  return Object.freeze({
    root,
    paths: statePaths(root),
    log,
    now,
    /** 按域取配置实时视图，缺失返回空对象 */
    config(domain) {
      const value = cfg[domain];
      return value && typeof value === 'object' ? value : {};
    },
    stores,
        /** 登记一份存储的名字，同名重复登记会报错 */
    register(name, store) {
      if (stores[name]) throw new Error(`AppContext: store ${name} 已登记`);
      stores[name] = store;
      return store;
    },
  });
}
