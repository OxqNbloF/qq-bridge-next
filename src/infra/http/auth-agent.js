// 库只能读时，就拒绝写请求
export function rejectReadonlyStore({ req, url, sendJson, stickerStoreWritable }) {
  // 只能读的库，写接口必须直接报错，不能假装存好了
  if (req.method !== 'GET') {
    const readonlyStore = (!stickerStoreWritable && ['/api/console/stickers/sync', '/api/console/stickers/note', '/api/console/stickers/remark', '/api/agent/sticker-note', '/api/agent/sticker-remark', '/api/agent/collect-sticker'].includes(url.pathname)) ? '表情库' : '';
    if (readonlyStore) {
      sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503, { safeError: true });
      return true;
    }
  }
  return false;
}
