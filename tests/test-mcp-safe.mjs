// 检查安全版 QQ MCP 服务器：工具清单和白名单拦截
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 读出当前运行模式，读不到就当聊天模式
function currentMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8')).mode;
  } catch {
    return 'chat';
  }
}
const MODE = currentMode();
const RESERVED2 = MODE === 'reserved2';

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ 安全 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const status = await client.callTool({ name: 'qq_status', arguments: {} });
  console.log('✅ qq_status:', status.content?.[0]?.text?.slice(0, 150));

  const groups = await client.callTool({ name: 'qq_list_groups', arguments: {} });
  console.log('✅ qq_list_groups:', groups.content?.[0]?.text?.slice(0, 200));

  const history = await client.callTool({ name: 'qq_get_group_history', arguments: { groupId: 123456789 } });
  const histText = history.content?.[0]?.text ?? '';
  if (RESERVED2) {
    assert.equal(history.isError, true, `reserved2 下旧只读工具应被拒绝: ${histText}`);
    console.log('🚫 reserved2 下旧只读工具不可用: 被拒绝 ✓', histText.slice(0, 120));
  } else {
    console.log('✅ qq_get_group_history 含 message_id:', /message_id/.test(histText) ? '是 ✓' : '否 ✗');
  }

  // 白名单外的群发消息，应该被拒绝
  const denied = await client.callTool({ name: 'qq_send_group_message', arguments: { groupId: 100003, message: '测试' } });
  assert.equal(denied.isError, true, `白名单外发送应被拒绝: ${denied.content?.[0]?.text}`);
  console.log('🚫 白名单外发送结果: 被拒绝 ✓', denied.content?.[0]?.text?.slice(0, 120));

  // 发消息工具应该带「回复某条消息」参数
  const tools2 = await client.listTools();
  const sendTool = tools2.tools.find((t) => t.name === 'qq_send_group_message');
  const schemaText = JSON.stringify(sendTool?.inputSchema ?? {});
  assert.equal(schemaText.includes('replyToMessageId'), true, '缺少 replyToMessageId 参数');
  assert.equal(tools2.tools.some((t) => t.name === 'qq_reply'), true, '缺少 qq_reply 工具');
  console.log('✅ replyToMessageId 参数 & qq_reply 工具存在 ✓');
  if (tools2.tools.some((t) => t.name === 'qq_slang_query' || t.name === 'qq_slang_submit')) {
    throw new Error('旧黑话工具 qq_slang_query / qq_slang_submit 仍存在');
  }
  console.log('✅ 旧黑话工具已移除: qq_slang_query / qq_slang_submit 不存在 ✓');

  // 白名单内但回复号不合法，应该被拒绝且不真发
  const invalidReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 'abc' }
  });
  assert.equal(invalidReply.isError, true, `非法引用 id(abc) 应被拒绝: ${invalidReply.content?.[0]?.text}`);
  console.log('🚫 非法引用 id(abc) 结果: 被拒绝 ✓', invalidReply.content?.[0]?.text?.slice(0, 120));

  const zeroReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 0 }
  });
  assert.equal(zeroReply.isError, true, `非法引用 id(0) 应被拒绝: ${zeroReply.content?.[0]?.text}`);
  console.log('🚫 非法引用 id(0) 结果: 被拒绝 ✓', zeroReply.content?.[0]?.text?.slice(0, 120));

  // 真实消息号可能是负数，应该只被白名单拦住
  const negativeReply = await client.callTool({
    name: 'qq_send_group_message',
    arguments: { groupId: 100003, message: '测试', replyToMessageId: -123456789 }
  });
  const negText = negativeReply.content?.[0]?.text ?? '';
  assert.equal(negativeReply.isError, true, `负 id + 白名单外应被拒绝: ${negText}`);
  console.log('🚫 负 id + 白名单外 结果: 被拒绝 ✓', negText.slice(0, 120), '| 校验阶段:', negText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  // 专用回复工具：白名单外 + 负数号应被白名单拦住
  const replyDenied = await client.callTool({
    name: 'qq_reply',
    arguments: { groupId: 100003, replyToMessageId: -123456789, message: '测试' }
  });
  const replyText = replyDenied.content?.[0]?.text ?? '';
  assert.equal(replyDenied.isError, true, `qq_reply 白名单外应被拒绝: ${replyText}`);
  console.log('🚫 qq_reply 白名单外 结果: 被拒绝 ✓', replyText.slice(0, 120), '| 校验阶段:', replyText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
