import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
// 起测试桥接跑一个用例，跑完关掉
async function test(name, run, options) {
  const h = await bridgeHarness(options);
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('#153 startup accepts explicit none', async (h) => {
  assert.equal(h.cfg.dsh.reasoningEffort, 'none');
}, { config: { dsh: { reasoningEffort: 'none' } } });
for (const effort of ['xHigh', 'HIGH', 'Low', 'MAX']) {
  await test(`#153 startup preserves adapter-owned effort ${effort}`, async (h) => {
    assert.equal(h.cfg.dsh.reasoningEffort, effort);
  }, { config: { dsh: { reasoningEffort: effort } } });
}
await test('#153 omitted effort keeps the max default', async (h) => {
  assert.equal(h.cfg.dsh.reasoningEffort, 'max');
}, { config: { dsh: {} } });
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ /* 重置要跟停止旧会话一样，清元数据并终止排队 */
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// 语音发送（AI 通道）的安全边界
// 语音比文字更重，真的会说话也撤不回，所以逐条钉住
// 来源只能来自语音库，白名单要命中，限流要生效
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认配置里 AI 不能发语音，这里显式打开
  // 才能测打开之后的各道闸门，关闭的行为下面单测
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库样例放在临时配置的根目录下
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 语音库外的文件，模拟随便一个本地文件
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库里的名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, path.join(audioDir, 'hello.mp3'), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒，防止被诱导外发本地文件
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 网址和内联内容被拒，体积和来源都不可控
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条到假网关：必须是语音段且指向库内文件
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, path.join(audioDir, 'hello.mp3'), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地检查：默认回读确认这条消息真的带语音段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意这些对象来自虚拟机，逐字段比对更稳
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 检查结果不能把源文件路径回传给 AI
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉检查时不回读
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：带本机路径特征的名字不许外发
    // 允许绝对路径时，文件名形态由那个开关管
    // 这里直接喂一个看起来像本机路径的名字，看审计拦不拦
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度单独算，超限就拒
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账，参数错误不该吃配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没消耗额度，紧接着真发一条应该成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 总开关关闭时，AI 通道彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 手动通道不受这个开关影响，否则连试发都做不了
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量倍数会传给音频处理，并原样回报
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须拦下，不能把怪值丢给音频工具
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// 语音路径：打开开关不再放宽 AI 通道
// 审计发现：开关打开时，AI 给的绝对路径会被直接采用
// 于是群友用诱导文字就能让 AI 把本机任意音频发出去
// 而音频检查在探测工具缺失时对任何文件都放行
// 现在即使开了开关，绝对路径也必须落在语音库内
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须拒绝，即使开关是打开的
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对路径穿越同样必须拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径仍然可用，开关本来就是这个用途
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// AI 令牌默认拒绝：v2 工具同时带着两种令牌
// 所以只靠控制台令牌挡不住群里的 AI
// 管理接口必须一律拒绝 AI 令牌，否则它能改自己
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    // 向本地接口发一个请求
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越和重复斜杠在拆开后仍要被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 该放行的只读接口不要误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理接口，管理员应该能正常访问
    h.api.callUnary = async (method) => {
      assert.equal(method, 'session.modelCatalog');
      return { result: { ok: true, value: { groups: [{ id: 'deepseek-official', models: [{
        id: 'deepseek-flash', reasoning: { efforts: ['low', 'xHigh', 'HIGH', 'Low', 'MAX'].map(id => ({ id, name: id })), defaultEffort: 'xHigh' }
      }] }] } } };
    };
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    const modelView = JSON.parse(adminOk.body);
    assert.deepEqual(modelView.options, ['low', 'xHigh', 'HIGH', 'Low', 'MAX', 'none'], '#153 保留适配器档位并始终提供不下发选项');
    assert.equal(modelView.providerDefault, 'xHigh');
    h.api.callUnary = async () => ({ result: { ok: true, value: { groups: [{ id: 'deepseek-official', models: [{
      id: 'deepseek-flash', name: 'Model without reasoning controls'
    }] }] } } });
    const noEffortView = JSON.parse((await call('/api/dsh/model', 'GET', adminOnly)).body);
    assert.deepEqual(noEffortView.options, ['none'], '#153 模型无思考档位时只提供不下发');
    assert.equal(noEffortView.catalogSource, 'dsh', '省略 reasoning 是目录公布的无思考能力，不能回退内置档位');
    assert.equal(noEffortView.providerDefault, null);
    for (const effort of ['xHigh', 'HIGH', 'Low', 'MAX']) {
      const customSave = await call('/api/dsh/effort', 'POST', adminOnly, { reasoningEffort: effort });
      assert.equal(customSave.status, 200);
      assert.equal(h.cfg.dsh.reasoningEffort, effort);
      assert.equal(JSON.parse((await call('/api/dsh/model', 'GET', adminOnly)).body).reasoningEffort, effort);
    }
    const noneSave = await call('/api/dsh/effort', 'POST', adminOnly, { reasoningEffort: 'none' });
    assert.equal(noneSave.status, 200);
    assert.equal(h.cfg.dsh.reasoningEffort, 'none');
    assert.equal(JSON.parse((await call('/api/dsh/model', 'GET', adminOnly)).body).reasoningEffort, 'none');
    const invalidSave = await call('/api/dsh/effort', 'POST', adminOnly, { reasoningEffort: '' });
    assert.equal(invalidSave.status, 400);
    assert.equal(h.cfg.dsh.reasoningEffort, 'none', '无效配置不得覆盖已保存值');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// 控制台入口的防护：Host 头、令牌定长比较、鉴权
// 这三条都是审计后加固的，钉住以防改回去
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    // 向本地接口发一个请求
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① 防 DNS 重绑定：不是本机的 Host 一律拒绝
    // 注意 Host 必须走请求头传，用参数会被覆盖
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 三个合法 Host 都要放行：127.0.0.1、localhost、::1
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须定长，错长度错内容都不能过
    // 注意客户端会自动裁掉请求头首尾空白
    // 所以带尾空格的情况必须用网址参数传
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ 读授权接口不再接受空令牌，它曾是免鉴权入口
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

if (failures) process.exitCode = 1;
