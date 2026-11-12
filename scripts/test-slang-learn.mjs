// 检查黑话学习功能：来源字段、研究提示词、读取
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
// 打印一条通过提示，并把通过数加一
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. 整理词条时保留网址，去掉空串，限制长度
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. 新建词条时能带上来源网址
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. 能读懂研究结果里的来源网址
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. 研究提示词要求联网查证并给出网址
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. 只把已确认、有意义的词条带进提示词
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
