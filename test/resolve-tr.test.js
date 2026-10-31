import test from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { parseRegPathQuery, queryRegistryPath, resolveTrLauncher } from '../resolve-tr.js'

function statOf(files) {
  return file => {
    const normalized = file.replaceAll('/', '\\').toLowerCase()
    const hit = Object.entries(files).find(([key]) => key.replaceAll('/', '\\').toLowerCase() === normalized)
    if (!hit) {
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    }
    return { isFile: () => true, size: hit[1] }
  }
}

test('parseRegPathQuery reads REG_EXPAND_SZ and ignores unrelated lines', () => {
  const text = [
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    C:\\Tools;%LOCALAPPDATA%\\Programs\\TokenRouter',
    '',
  ].join('\r\n')
  assert.equal(parseRegPathQuery(text), 'C:\\Tools;%LOCALAPPDATA%\\Programs\\TokenRouter')
  assert.equal(parseRegPathQuery('no value here'), '')
})

test('queryRegistryPath calls absolute reg.exe with argv and no shell', () => {
  const calls = []
  const text = queryRegistryPath((file, args, options) => {
    calls.push({ file, args, options })
    if (String(args[1]).startsWith('HKCU')) return '    Path    REG_EXPAND_SZ    C:\\FromUser\r\n'
    return '    Path    REG_SZ    C:\\FromMachine\r\n'
  }, { SystemRoot: 'C:\\Windows' })
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\reg.exe')
  assert.deepEqual(calls[0].args, ['query', 'HKCU\\Environment', '/v', 'Path'])
  assert.equal(calls[0].options.windowsHide, true)
  assert.equal(text, 'C:\\FromUser;C:\\FromMachine')
})

test('A bare tr.exe name resolves to tr.exe, not tr.exe.exe', () => {
  const found = resolveTrLauncher('tr.exe', {
    platform: 'win32',
    env: { PATH: 'C:\\TokenRouter' },
    readRegistryPath: false,
    stat: statOf({ 'C:\\TokenRouter\\tr.exe': 100 }),
  })
  assert.equal(found.file, 'C:\\TokenRouter\\tr.exe')
  assert.equal(found.source, 'path')
})

test('Windows prefers tr.exe over an earlier tr.cmd and skips WindowsApps aliases', () => {
  const found = resolveTrLauncher('tr', {
    platform: 'win32',
    env: {
      PATH: 'C:\\WindowsApps;C:\\npm;C:\\TokenRouter',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    },
    readRegistryPath: false,
    stat: statOf({
      'C:\\WindowsApps\\tr.exe': 0,
      'C:\\npm\\tr.cmd': 40,
      'C:\\TokenRouter\\tr.exe': 100,
    }),
  })
  assert.equal(found.file, 'C:\\TokenRouter\\tr.exe')
  assert.deepEqual(found.skippedScripts, ['C:\\npm\\tr.cmd'])
})

test('Windows falls back to the known TokenRouter install when PATH is stale', () => {
  const found = resolveTrLauncher('tr', {
    platform: 'win32',
    env: {
      PATH: 'C:\\Windows\\System32',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    },
    readRegistryPath: () => '%LOCALAPPDATA%\\Programs\\TokenRouter',
    stat: statOf({
      'C:\\Users\\me\\AppData\\Local\\Programs\\TokenRouter\\tr.exe': 80,
    }),
  })
  assert.equal(found.file, 'C:\\Users\\me\\AppData\\Local\\Programs\\TokenRouter\\tr.exe')
  assert.equal(found.source, 'registry')
})

test('A configured .cmd is rejected instead of being passed to cmd.exe', () => {
  assert.throws(() => resolveTrLauncher('C:\\npm\\tr.cmd', {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    readRegistryPath: false,
    stat: statOf({
      'C:\\npm\\tr.cmd': 20,
      'C:\\Users\\me\\AppData\\Local\\Programs\\TokenRouter\\tr.exe': 80,
    }),
  }), /无法安全启动/)
})

test('PowerShell-style names and shell metacharacters are rejected', () => {
  assert.throws(() => resolveTrLauncher('tr && calc', { platform: 'win32', env: {}, readRegistryPath: false, stat: statOf({}) }), /shell 元字符/)
  assert.throws(() => resolveTrLauncher('.\\tr.exe', { platform: 'win32', env: {}, readRegistryPath: false, stat: statOf({}) }), /相对路径/)
})

test('Missing launcher explains PATH and PowerShell differences', () => {
  assert.throws(() => resolveTrLauncher('tr', {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    readRegistryPath: false,
    stat: statOf({}),
  }), /PowerShell/)
})

test('POSIX resolution does not require a .exe suffix', () => {
  const found = resolveTrLauncher('tr', {
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    readRegistryPath: false,
    stat: statOf({ '/usr/bin/tr': 10 }),
  })
  assert.equal(found.file, '/usr/bin/tr')
})

test('live Windows TokenRouter resolution', (t) => {
  if (process.platform !== 'win32') return t.skip('not Windows')
  let found
  try {
    found = resolveTrLauncher('tr', { readRegistryPath: false })
  } catch {
    return t.skip('本机没有可解析的 tr.exe，实机解析未执行')
  }
  assert.equal(found.kind, 'exe')
  assert.match(found.file, /tr\.exe$/i)
  assert.equal(statSync(found.file).isFile(), true)
})
