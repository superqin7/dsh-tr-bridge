import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { apply, commandFor, invoke, previewLaunch, redact, resolveWorkspace, toolParameters } from '../index.js'

test('Explicit Codex model is a --model argument before the task separator', () => {
  const argv = commandFor('codex', '只回复 CODEX_OK', 'C:\\TokenRouter\\tr.exe', { model: 'gpt-5.6-terra' })
  assert.deepEqual(argv.slice(0, 10), [
    'C:\\TokenRouter\\tr.exe', 'codex', 'exec', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '--model', 'gpt-5.6-terra',
  ])
  assert.equal(argv.at(-2), '--')
  assert.equal(argv.at(-1), '只回复 CODEX_OK')
  assert.ok(argv.indexOf('--model') < argv.indexOf('--'))
})

test('Omitting model keeps the previous argv and does not invent a model', () => {
  const argv = commandFor('codex', 'CODEX_OK', 'C:\\TokenRouter\\tr.exe')
  assert.equal(argv.includes('--model'), false)
  assert.equal(argv.at(-2), '--')
})

test('Grok model is a separate argv before the prompt', () => {
  const argv = commandFor('grok', 'GROK_OK', 'C:\\TokenRouter\\tr.exe', { model: 'tokenrouter-grok-4.7' })
  const modelAt = argv.indexOf('--model')
  assert.equal(argv[modelAt + 1], 'tokenrouter-grok-4.7')
  assert.ok(modelAt < argv.indexOf('-p'))
  assert.equal(argv.filter(item => item === 'tokenrouter-grok-4.7').length, 1)
})

test('Model ids cannot smuggle shell syntax', () => {
  assert.throws(() => commandFor('codex', 'task', 'C:\\TokenRouter\\tr.exe', { model: 'gpt-5.6-terra & calc' }), /模型 ID/)
  assert.throws(() => commandFor('grok', 'task', 'tr', { model: 'grok-4.6;whoami' }), /模型 ID/)
})

test('Codex runs through TR with a read-only sandbox and a literal task argument', () => {
  const task = 'CODEX_OK & calc.exe %PATH%'
  assert.deepEqual(commandFor('codex', task, 'C:\\TokenRouter\\tr.exe'), [
    'C:\\TokenRouter\\tr.exe', 'codex', 'exec', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '--', task,
  ])
})

test('Grok runs through TR with dontAsk and a read-only tool allowlist', () => {
  const args = commandFor('grok', 'GROK_OK & whoami', 'C:\\TokenRouter\\tr.exe')
  assert.equal(args[0], 'C:\\TokenRouter\\tr.exe')
  assert.deepEqual(args.slice(1, 3), ['grok', '--permission-mode'])
  assert.ok(args.includes('dontAsk'))
  assert.ok(args.includes('read_file,grep,list_dir'))
  assert.ok(args.includes('--disable-web-search'))
  assert.equal(args.at(-2), '-p')
  assert.match(args.at(-1), /不得修改文件/)
  assert.match(args.at(-1), /GROK_OK & whoami/)
  assert.equal(args.filter(item => item === args.at(-1)).length, 1)
})

test('Grok web search stays off unless explicitly enabled', () => {
  const disabled = commandFor('grok', 'x', 'tr')
  const enabled = commandFor('grok', 'x', 'tr', { grokWebSearch: true })
  assert.ok(disabled.includes('--disable-web-search'))
  assert.equal(enabled.includes('--disable-web-search'), false)
})

test('Rejects empty, oversized, and unsupported requests', () => {
  assert.throws(() => commandFor('foo', 'test'), /仅支持/)
  assert.throws(() => commandFor('codex', ''), /不能为空/)
  assert.throws(() => commandFor('codex', 'bad\0task'), /控制字符/)
  assert.throws(() => commandFor('grok', 'x'.repeat(20_001)), /不得超过/)
})

test('Requires a real session workspace and prefers a later cd', async () => {
  await assert.rejects(resolveWorkspace({}), /工作区/)
  assert.equal(await resolveWorkspace({ agent: { session: { header: { cwd: 'C:\\work\\example-repo' } } } }), 'C:\\work\\example-repo')
  const cwd = await resolveWorkspace({
    agent: { session: { header: { cwd: 'C:\\original' } } },
    signal: undefined,
  }, {
    ensure(agent) {
      assert.equal(agent.session.header.cwd, 'C:\\original')
      return 'C:\\work\\after-cd'
    },
  })
  assert.equal(cwd, 'C:\\work\\after-cd')
})

test('Tool parameters match the 0.2.1-rc.5 raw JSON Schema subset', () => {
  assert.equal(toolParameters.type, 'object')
  assert.equal(toolParameters.additionalProperties, false)
  assert.deepEqual(toolParameters.required, ['agent', 'task'])
  assert.deepEqual(toolParameters.properties.agent.enum, ['codex', 'grok'])
  for (const [key, schema] of Object.entries(toolParameters.properties)) {
    assert.equal(typeof schema.type, 'string', key)
    assert.equal(Object.hasOwn(schema, 'properties'), false)
  }
  assert.deepEqual(Object.keys(toolParameters).sort(), ['additionalProperties', 'properties', 'required', 'type'])
})

function fakeChild(stdoutText, stderrText, exitCode = 0) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = { end() {} }
  let terminated = false
  const done = new Promise(resolve => {
    setImmediate(() => {
      if (stdoutText) stdout.emit('data', Buffer.from(stdoutText))
      if (stderrText) stderr.emit('data', Buffer.from(stderrText))
      resolve({ exitCode })
    })
  })
  return { stdout, stderr, stdin, done, terminate() { terminated = true }, get terminated() { return terminated } }
}

test('Runs mocked CLI, closes stdin, and scrubs obvious credential strings', async () => {
  const child = fakeChild('GROK_OK token=secretpassword\nAPI密钥：abc123\n', '', 0)
  let ended = false
  child.stdin.end = () => { ended = true }
  const result = await invoke({
    subprocess: { spawn: spec => { assert.equal(spec.argv[0], 'tr'); assert.equal(spec.graceMs, 3000); assert.equal(spec.stdio.stdin, 'pipe'); return child } },
    argv: ['tr', 'grok', '-p', 'GROK_OK'],
    cwd: 'C:\\project',
    timeoutMs: 2000,
  })
  assert.equal(ended, true)
  assert.match(result, /GROK_OK/)
  assert.doesNotMatch(result, /secretpassword/)
  assert.doesNotMatch(result, /abc123/)
})

test('Nonzero CLI exit reports a safe diagnostic', async () => {
  const child = fakeChild('', 'Access denied token=secretpassword', 1)
  await assert.rejects(invoke({
    subprocess: { spawn: () => child },
    argv: ['tr', 'codex', 'exec', 'ping'],
    cwd: 'C:\\project',
    timeoutMs: 2000,
  }), error => {
    assert.match(error.message, /退出码 1/)
    assert.match(error.message, /Access denied/)
    assert.doesNotMatch(error.message, /secretpassword/)
    return true
  })
})

test('Cancellation terminates the child', async () => {
  const child = fakeChild('', '', 0)
  child.done = new Promise(() => {})
  const controller = new AbortController()
  const pending = invoke({
    subprocess: { spawn: () => child },
    argv: ['tr', 'grok', '-p', 'wait'],
    cwd: 'C:\\project',
    signal: controller.signal,
    timeoutMs: 2000,
  })
  controller.abort()
  await assert.rejects(pending, /已取消/)
  assert.equal(child.terminated, true)
})

test('Timeout terminates the child', async () => {
  const child = fakeChild('', '', 0)
  child.done = new Promise(() => {})
  await assert.rejects(invoke({
    subprocess: { spawn: () => child },
    argv: ['tr', 'codex', 'exec', 'wait'],
    cwd: 'C:\\project',
    timeoutMs: 20,
  }), /执行超时/)
  assert.equal(child.terminated, true)
})

test('Registers the DSH tool; dry-run does not launch a child', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-'))
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  let tool
  const ctx = {
    tools: { register(value) { tool = value } },
    get(service) {
      assert.notEqual(service, 'subprocess')
      return undefined
    },
  }
  apply(ctx, { trCommand: launcher })
  assert.equal(tool.name, 'tr_bridge')
  assert.equal(tool.parameters, toolParameters)
  assert.equal(typeof tool.output.render, 'function')
  const preview = await tool.execute({ agent: 'codex', task: 'inspect & calc', dryRun: true }, {
    agent: { session: { header: { cwd: 'C:\\work\\example-repo' } } },
  })
  assert.match(preview, /预览（未执行）/)
  assert.match(preview, /read-only/)
  assert.match(preview, /tr\.exe/i)
  assert.doesNotMatch(preview, /inspect & calc/)
})

test('dry-run shows the selected model, argv, and workspace without the task body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-'))
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  const selection = join(dir, 'missing-selection.json')
  let tool
  const ctx = {
    tools: { register(value) { if (value.name === 'tr_bridge') tool = value } },
    subprocess: {
      spawn(spec) {
        assert.equal(spec.argv[0], launcher)
        assert.deepEqual(spec.argv.slice(1, 4), ['codex', 'debug', 'models'])
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        const done = Promise.resolve({ exitCode: 0 })
        setImmediate(() => stdout.emit('data', Buffer.from(JSON.stringify({
          models: [
            { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', supported_in_api: true },
            { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', supported_in_api: true },
          ],
        }))))
        return { stdout, stderr, stdin: { end() {} }, done, terminate() {} }
      },
    },
  }
  apply(ctx, { trCommand: launcher, selectionFile: selection })
  const preview = await tool.execute({
    agent: 'codex',
    task: 'secret task & calc',
    model: 'gpt-5.6-terra',
    dryRun: true,
  }, { agent: { session: { header: { cwd: 'D:\\AI-team\\tr-bridge-test' } } } })
  assert.match(preview, /gpt-5\.6-terra/)
  assert.match(preview, /--model/)
  assert.ok(preview.includes('D:\\AI-team\\tr-bridge-test'))
  assert.equal(preview.includes('secret task'), false)
  assert.match(preview, /已在本次 codex 清单中确认/)
})

test('dry-run uses the session working directory after cd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-'))
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  let tool
  const ctx = {
    tools: { register(value) { tool = value } },
    workingDirectory: { ensure() { return 'D:\\session\\after-cd' } },
    get() { throw new Error('should use the injected workingDirectory service') },
  }
  apply(ctx, { trCommand: launcher })
  const preview = await tool.execute({ agent: 'grok', task: 'look', dryRun: true }, {
    agent: { session: { header: { cwd: 'D:\\original' } } },
  })
  assert.ok(preview.includes('D:\\session\\after-cd'))
  assert.equal(preview.includes('D:\\original'), false)
})

test('Preview states that Grok restrictions are not a Windows kernel sandbox', () => {
  const text = previewLaunch({ file: 'C:\\tr.exe', source: 'configured', skippedScripts: [] }, 'grok', 'look', { cwd: 'C:\\work' })
  assert.match(text, /不是 Windows 内核沙箱/)
  assert.match(text, /未验证/)
})

test('Redacts setup keys without dropping the surrounding diagnostic', () => {
  assert.equal(redact('failed TR_SETUP_KEY=super-secret'), 'failed [REDACTED]')
})

function catalogChild(body, exitCode = 0) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const done = Promise.resolve({ exitCode })
  setImmediate(() => stdout.emit('data', Buffer.from(body)))
  return { stdout, stderr, stdin: { end() {} }, done, terminate() {} }
}

function catalogSpawn(state) {
  return {
    spawn(spec) {
      state.calls.push(spec.argv.slice())
      const argv = spec.argv
      if (state.fail) return catalogChild('query failed', 1)
      if (argv.includes('debug')) return catalogChild(JSON.stringify({ models: state.codex }))
      if (argv.includes('grok') && argv.includes('models')) return catalogChild(state.grokText)
      throw new Error(`unexpected catalog argv: ${argv.join(' ')}`)
    },
  }
}

function installTools(dir, state, config = {}) {
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  const tools = {}
  const ctx = {
    tools: { register(value) { tools[value.name] = value } },
    subprocess: catalogSpawn(state),
  }
  apply(ctx, { trCommand: launcher, selectionFile: join(dir, 'model-selection.json'), ...config })
  return { tools, launcher, selection: join(dir, 'model-selection.json') }
}

const session = { agent: { session: { header: { cwd: 'D:\\AI-team\\tr-bridge-test' } } } }

test('refresh, save, member binding, revocation, and fallback do not use a hardcoded catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-'))
  const state = {
    calls: [],
    fail: false,
    codex: [
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', supported_in_api: true },
      { slug: 'future-model', display_name: 'Future Model', visibility: 'list', supported_in_api: true },
      { slug: 'internal-review', display_name: 'Internal', visibility: 'hide', supported_in_api: true },
    ],
    grokText: 'Available models:\n  * grok-4.6 (default)\n  - brand-new-model\n',
  }
  const { tools, selection } = installTools(dir, state)
  const listed = await tools.tr_bridge_models.execute({ action: 'refresh' }, session)
  assert.match(listed, /future-model/)
  assert.match(listed, /Future Model/)
  assert.match(listed, /brand-new-model/)
  assert.equal(listed.includes('internal-review'), false)
  assert.match(listed, /未放入可选项/)

  const saved = await tools.tr_bridge_models.execute({
    action: 'set-default', agent: 'codex', model: 'future-model',
  }, session)
  assert.match(saved, /Future Model（future-model）/)
  const member = await tools.tr_bridge_models.execute({
    action: 'set-default', agent: 'grok', model: 'brand-new-model', member: 'writer',
  }, session)
  assert.match(member, /writer/)
  const onDisk = JSON.parse(readFileSync(selection, 'utf8'))
  assert.equal(onDisk.defaults.codex, 'future-model')
  assert.equal(onDisk.members.writer.model, 'brand-new-model')
  assert.equal(onDisk.defaults.grok, undefined)
  const memberPreview = await tools.tr_bridge.execute({
    agent: 'grok', member: 'writer', task: 'secret task', dryRun: true,
  }, session)
  assert.match(memberPreview, /brand-new-model/)
  assert.equal(memberPreview.includes('secret task'), false)
  const otherMember = await tools.tr_bridge.execute({
    agent: 'codex', member: 'writer', task: 'secret task', dryRun: true,
  }, session).catch(error => error)
  assert.match(otherMember.message, /不能用于 codex/)

  const preview = await tools.tr_bridge.execute({
    agent: 'codex', task: 'secret task & calc', dryRun: true,
  }, session)
  assert.match(preview, /future-model/)
  assert.match(preview, /--model/)
  assert.ok(preview.includes('D:\\AI-team\\tr-bridge-test'))
  assert.equal(preview.includes('secret task'), false)
  const argv = JSON.parse(preview.split('参数：')[1].split('\n')[0])
  assert.equal(argv.includes('future-model'), true)
  assert.ok(argv.indexOf('--model') < argv.indexOf('--'))
  assert.equal(argv.includes('--skip-git-repo-check'), false)

  state.codex = state.codex.filter(item => item.slug !== 'future-model')
  await assert.rejects(tools.tr_bridge.execute({
    agent: 'codex', task: 'secret task', dryRun: true,
  }, session), /不在本次/)

  await tools.tr_bridge_models.execute({ action: 'clear-default', agent: 'codex' }, session)
  const fallback = await tools.tr_bridge.execute({
    agent: 'codex', task: 'secret task', dryRun: true,
  }, session)
  assert.match(fallback, /未指定/)
  assert.equal(fallback.includes('"--model"'), false)

  await assert.rejects(tools.tr_bridge.execute({
    agent: 'grok', model: 'gpt-5.6-terra', task: 'secret task', dryRun: true,
  }, session), /属于 codex/)
  await assert.rejects(tools.tr_bridge.execute({
    agent: 'codex', model: 'gpt-5.6-terra & calc', task: 'secret task', dryRun: true,
  }, session), /模型 ID/)
})

test('query failure invalidates authorization and a profile default survives clear-default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-'))
  const state = {
    calls: [],
    fail: true,
    codex: [],
    grokText: '',
  }
  const failed = installTools(dir, state)
  writeFileSync(failed.selection, JSON.stringify({ defaults: { codex: 'gpt-5.6-terra' }, members: {} }))
  await assert.rejects(failed.tools.tr_bridge.execute({
    agent: 'codex', task: 'secret task', dryRun: true,
  }, session), /查询|调用失败|不会沿用/)

  const profile = installTools(mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-')), {
    calls: [],
    fail: false,
    codex: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list' }],
    grokText: 'Available models:\n  - grok-4.6\n',
  }, { defaults: { codex: 'gpt-5.6-sol' } })
  const cleared = await profile.tools.tr_bridge_models.execute({ action: 'clear-default', agent: 'codex' }, session)
  assert.match(cleared, /插件配置仍指定 gpt-5\.6-sol/)
  const preview = await profile.tools.tr_bridge.execute({
    agent: 'codex', task: 'secret task', dryRun: true,
  }, session)
  assert.match(preview, /gpt-5\.6-sol/)
  assert.match(preview, /--model/)
})

test('MIT license and upstream acknowledgements stay in the public tree', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
  const notice = readFileSync(new URL('../NOTICE.md', import.meta.url), 'utf8')
  assert.match(license, /MIT License/)
  assert.match(license, /Super秦/)
  assert.match(notice, /MJorgin\/dsh-agent-conductor/)
  assert.match(notice, /NanmiCoder\/dsh-agent-teams/)
  assert.match(notice, /Tikzen\/dsh-agent-arena/)
  assert.match(notice, /DeepSeek Harness/)
})
