import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const sourceUrl = new URL('../lib/client.js', import.meta.url)
const source = readFileSync(sourceUrl, 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function loadFactory() {
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { sandbox.loaded = spec } } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return sandbox.loaded
}

test('the client entry is a real file and is declared as the web bundle', () => {
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.ok(packageJson.files.includes('lib/client.js'))
  assert.equal(packageJson.dsh.client.platform, 'web')
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-connection'))
  assert.equal(source.includes('window.__ModuleLoader__.load'), true)
  assert.equal(source.includes("id: 'dsh-tr-bridge'"), true)
  assert.equal(source.includes('plugins.row.config'), true)
  assert.equal(source.includes('dsh-tr-bridge#tr-bridge'), true)
  assert.equal(source.includes("require('react')"), true)
  assert.equal(source.includes('@deepseek-ai/dsh-client-ui-primitives'), true)
})

test('the client bundle does not read credentials, status output, or hardcoded model ids', () => {
  assert.equal(/readFileSync|credentials|auth\.json|\.codex|tr status|type:\s*['"]password['"]|document\.body/i.test(source), false)
  assert.equal(/gpt-5|grok-4|tokenrouter/i.test(source), false)
  assert.equal(source.includes('apiKey'), false)
})

test('the factory registers the row config page and can render without a model allowlist', () => {
  const loaded = loadFactory()
  assert.equal(loaded.id, 'dsh-tr-bridge')
  const calls = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect() {},
    Component: class {
      constructor(props) { this.props = props }
      render() { return this.props.children }
    },
  }
  const plugin = loaded.factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button() { return null } }
    throw new Error(`unexpected require ${id}`)
  })
  assert.equal(Array.from(plugin.inject).join(','), 'slots,locale,connection')
  const registered = []
  plugin.apply({
    locale: { register(ns, dictionaries) { registered.push(['locale', ns, dictionaries.zh.summary]) } },
    slots: {
      inject(name, register) { registered.push(['inject', name]); register() },
      register(options, component) { registered.push(['slot', options.key]); calls.push(component) },
    },
  })
  assert.equal(registered.some(item => item[0] === 'slot' && item[1] === 'dsh-tr-bridge#tr-bridge'), true)
  const Slot = calls[0]
  assert.equal(Slot({ t: key => key, view: 'summary' }), 'summary')
  const page = Slot({ t: key => `文案:${key}`, view: 'page' })
  assert.equal(typeof page.type, 'function')
  assert.equal(JSON.stringify(page).includes('gpt-'), false)
})

test('the page asks the host to refresh and renders only returned model ids', async () => {
  const calls = []
  const react = {
    states: [],
    cursor: 0,
    effects: [],
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }
    },
    useState(init) {
      const index = this.cursor++
      if (this.states[index] === undefined) this.states[index] = typeof init === 'function' ? init() : init
      return [this.states[index], () => {}]
    },
    useEffect(fn) { this.effects.push(fn) },
    Component: class {
      constructor(props) { this.props = props }
      render() { return this.props.children }
    },
  }
  const plugin = loadFactory().factory((id) => {
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Button() { return null } }
    throw new Error(`unexpected require ${id}`)
  })
  let Slot
  plugin.apply({
    locale: { register() {} },
    slots: { inject(_name, register) { register() }, register(_options, component) { Slot = component } },
    connection: {
      rpc: {
        async call(channel, endpoint, payload) {
          calls.push({ channel, endpoint, payload })
          return {
            ok: true,
            value: {
              agents: [{
                agent: 'grok',
                connection: 'connected',
                selection: 'unset',
                models: [
                  { id: 'listed-model', name: 'Listed Model', kind: 'model', selectable: true },
                  { id: 'listed-alias', name: 'listed-alias', kind: 'alias', selectable: true },
                ],
                excluded: 0,
              }],
            },
          }
        },
      },
    },
  })
  react.cursor = 0
  const page = Slot({ t: key => key, view: 'page' })
  const child = page.children[0]
  react.cursor = 0
  child.type(child.props)
  await react.effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(item => item.endpoint), ['status', 'refresh'])
  assert.equal(calls.every(item => item.channel === '/dsh-tr-bridge'), true)
  assert.equal(JSON.stringify(calls).includes('listed-model'), false)
})

test('a primitive load failure still returns a plugin body', () => {
  const plugin = loadFactory().factory(() => { throw new Error('primitives unavailable') })
  assert.equal(typeof plugin.apply, 'function')
  assert.doesNotThrow(() => plugin.apply({
    locale: { register() { throw new Error('locale down') } },
    slots: { inject() { throw new Error('slot down') } },
  }))
})


