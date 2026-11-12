// 操作者预写的每会话初始提示词（state/initial-prompts.json）
import fs from 'node:fs';
import { canonicalV2Key } from '../policy/access.js';
import { atomicWriteJson } from '../store/fs-atomic.js';
import { migrateDocument, stampSchema } from '../store/schema.js';

// 创建初始提示词存储
export function createInitialPromptStore(b) {
  // 单条初始提示词的字数上限
  function initialPromptMaxChars() {
    const n = Number(b.cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

/** 整理输入文字：统一换行、去掉特殊记号、裁掉首尾空白 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /** 读初始提示词；读坏了就只读不写，免得空表覆盖原文件 */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(b.INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        b.initialPromptsWritable = false;
        b.log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      b.initialPromptsWritable = false;
      b.log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      b.initialPromptsWritable = false;
      b.log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    // schemaVersion 不是会话 key，下面的过滤会跳过它
    try { migrateDocument('initial-prompts', parsed); }
    catch (error) {
      b.initialPromptsWritable = false;
      b.log(`⚠️ initial-prompts.json：${error?.message ?? error}；已降级为「只读不写」`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key，顺带滤掉 __proto__ 等脏键
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 读进来时先不截断，免得保存时悄悄丢内容；上限只在保存和使用时算
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      b.initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (b.initialPrompts.size) b.log(`已加载 ${b.initialPrompts.size} 条会话初始提示词`);
  }

  // 一次写完整个文件；只读状态下不写
  function saveInitialPrompts() {
    if (!b.initialPromptsWritable) {
      b.log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of b.initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(b.INITIAL_PROMPTS_FILE, stampSchema('initial-prompts', obj));
      return true;
    } catch (error) {
      b.log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  // 取一个会话的初始提示词
  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (b.initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存一条初始提示词；内容为空就是删除。写失败就把内存改回去。
   * @returns {object} 成功了吗、错误是什么、有没有删掉
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = b.initialPrompts.get(canonical) ?? null;
    // 写文件失败时把内存改回原来的样子
    const rollback = () => { if (prev) b.initialPrompts.set(canonical, prev); else b.initialPrompts.delete(canonical); };
    if (!text) {
      b.initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    b.initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  return { initialPromptMaxChars, normalizeInitialPromptText, loadInitialPrompts, saveInitialPrompts, getInitialPrompt, setInitialPrompt };
}
