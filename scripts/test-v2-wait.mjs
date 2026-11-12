// 测「对方好像还没说完，就多等一会儿」的逻辑
// 看它认不认得常见的半截话，等待时长对不对
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  looksLikeUnfinished,
  UNFINISHED_PROMPT_REPLIES,
  END_ROUND_WAIT_MIN_MS,
  END_ROUND_WAIT_MAX_MS
} from '../src/v2-wait.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
// 检查一项：通过打勾，失败打叉并记下
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed = 1;
  }
}

// 1. 常见的半截话，应该判为没说完
const unfinishedCases = [
  '你知道',
  '等一下',
  '我跟你讲',
  '但是',
  '所以说',
  '然后',
  '那个',
  '就是',
  '我想说',
  '对了',
  '等我',
  '等等',
  '我看看',
  '还有',
  '再说',
  '主要是',
  '回头说',
  '待会',
  '再说吧',
  '你听我说，'
];
for (const text of unfinishedCases) {
  assert(looksLikeUnfinished(text) === true, `未说完判定 true: ${JSON.stringify(text)}`);
}

// 2. 说完了的话，不该被误判成没说完
const finishedCases = [
  '',
  '好的',
  '今天好累',
  'B站搜猫踩奶视频 解压一绝',
  '那去看跳伞第一视角视频',
  '你再说一遍试试',
  '？',
  '哦牛批',
  '这么刺激',
  '你说完了。'
];
for (const text of finishedCases) {
  assert(looksLikeUnfinished(text) === false, `已说完/普通判定 false: ${JSON.stringify(text)}`);
}

// 3. 配置里的最长等待时间够不够
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const maxMs = Number(cfg.socialV2?.wait?.maxMs) || 0;
  assert(maxMs >= END_ROUND_WAIT_MAX_MS, `wait.maxMs=${maxMs} >= 600000`);
} catch (error) {
  console.error('❌ 读取 config.example.json 失败:', error.message);
  failed = 1;
}

// 4. 有没有准备好催对方继续说下去的短句
assert(Array.isArray(UNFINISHED_PROMPT_REPLIES) && UNFINISHED_PROMPT_REPLIES.length > 0, '提供催话短句');
assert(END_ROUND_WAIT_MIN_MS >= 5 * 60 * 1000 && END_ROUND_WAIT_MAX_MS >= END_ROUND_WAIT_MIN_MS, '结束前等待 5~10 分钟常量正确');

if (failed) {
  console.error('\n❌ 测试失败');
  process.exit(1);
}
console.log('\n🎉 二代等待/结束回合逻辑测试通过');
