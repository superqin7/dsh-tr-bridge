import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { apply, commandFor, invoke, previewLaunch, redact, resolveWorkspace, toolParameters } from '../index.js'

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
