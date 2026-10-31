/**
 * Resolve the TokenRouter launcher for DeepSeek Harness 0.2.1-rc.5.
 *
 * The desktop subprocess uses CreateProcessW and only accepts .exe/.com.
 * A .cmd/.bat/.ps1 must not be started through cmd.exe or PowerShell, because
 * the task text would be parsed as shell syntax.
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1'])
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com']
const BARE_NAME = /^[A-Za-z0-9._-]+$/

export function commandExtension(file) {
  const dot = file.lastIndexOf('.')
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  if (dot <= slash) return ''
  return file.slice(dot).toLowerCase()
}

export function expandWindowsEnv(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => {
    const found = Object.keys(env).find(key => key.toUpperCase() === String(name).toUpperCase())
    return found === undefined ? match : env[found] ?? match
  })
}

/** Parse `reg query ... /v Path` text. Returns '' when the value is absent. */
export function parseRegPathQuery(text) {
  const lines = String(text).split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
    if (match) return match[1].trim()
  }
  return ''
}

function environmentValue(env, name) {
  const found = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase())
  return found === undefined ? undefined : env[found]
}

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix
}

function splitPath(value, platform) {
  return String(value ?? '')
    .split(pathApi(platform).delimiter)
    .map(entry => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function fileFacts(file, io) {
  try {
    const stat = io.stat(file)
    if (!stat.isFile() || stat.size <= 0) return undefined
    return { file, size: stat.size }
  } catch {
    return undefined
  }
}

function isWindowsAppsAlias(file) {
  return /[\\/]WindowsApps[\\/]/i.test(file)
}

function knownWindowsInstalls(env) {
  const local = environmentValue(env, 'LOCALAPPDATA')
  const home = environmentValue(env, 'USERPROFILE') || environmentValue(env, 'HOME')
  const roots = []
  if (local) roots.push(win32.join(local, 'Programs', 'TokenRouter'), win32.join(local, 'TokenRouter'))
  if (home) roots.push(win32.join(home, 'AppData', 'Local', 'Programs', 'TokenRouter'))
  return roots
}

function readRegistryPath(io, env) {
  if (io.platform !== 'win32' || io.readRegistryPath === false) return []
  const reader = io.readRegistryPath ?? defaultReadRegistryPath
  try {
    return splitPath(expandWindowsEnv(reader(), env), 'win32')
  } catch {
    return []
  }
}

/**
 * Read user and machine Path with an absolute reg.exe argv. No shell.
 * A missing value is ignored so a stale GUI PATH can still fall through.
 * @param {typeof execFileSync} [execFile]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function queryRegistryPath(execFile = execFileSync, env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  const reg = win32.join(root, 'System32', 'reg.exe')
  const chunks = []
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      chunks.push(execFile(reg, ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      }))
    } catch {
      // A missing user or machine Path value is not fatal.
    }
  }
  return chunks.map(parseRegPathQuery).filter(Boolean).join(';')
}

function defaultReadRegistryPath() {
  return queryRegistryPath()
}

function windowsCandidateNames(command) {
  const extension = commandExtension(command)
  if (WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension) || WINDOWS_SCRIPT_EXTENSIONS.has(extension)) {
    return [command]
  }
  return [
    ...WINDOWS_EXECUTABLE_EXTENSIONS.map(item => command + item),
    ...[...WINDOWS_SCRIPT_EXTENSIONS].map(item => command + item),
  ]
}

function reject(message) {
  const error = new Error(message)
  error.code = 'TR_LAUNCHER_UNUSABLE'
  return error
}

function scriptError(file, alternative) {
  const hint = alternative
    ? `已另发现可执行文件：${alternative}`
    : 'TokenRouter 的 Windows 安装通常提供 %LOCALAPPDATA%\\Programs\\TokenRouter\\tr.exe。'
  return reject(
    `无法安全启动 ${file}。DeepSeek Harness 0.2.1-rc.5 在 Windows 上通过 CreateProcessW 启动进程，只接受 .exe 或 .com。`
    + '把任务文本交给 cmd.exe 或 PowerShell 会让 &、|、% 等字符被当成命令。'
    + `请把插件配置 trCommand 设为 tr.exe 的完整路径。${hint}`,
  )
}

function validateRequestedCommand(trCommand) {
  if (typeof trCommand !== 'string' || !trCommand.trim()) {
    throw reject('trCommand 配置不能为空')
  }
  if (/[\0\r\n]/.test(trCommand)) throw reject('trCommand 含有非法控制字符')
  const command = trCommand.trim()
  if (/[&|<>^%]/.test(command)) {
    throw reject('trCommand 不能包含 shell 元字符。请填写 tr.exe 的完整路径，或只填写 tr。')
  }
  return command
}

/**
 * @param {string} trCommand bare name or absolute launcher path
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, stat?: Function, readRegistryPath?: Function | false }} [io]
 * @returns {{ file: string, kind: 'exe', source: string, skippedScripts: string[] }}
 */
export function resolveTrLauncher(trCommand = 'tr', io = {}) {
  const platform = io.platform ?? process.platform
  const paths = pathApi(platform)
  const env = io.env ?? process.env
  const stat = io.stat ?? (file => statSync(file))
  const factsOf = file => fileFacts(file, { stat })
  const command = validateRequestedCommand(trCommand)
  const hasSeparator = /[\\/]/.test(command)

  if (hasSeparator && !paths.isAbsolute(command)) {
    throw reject('trCommand 不能是相对路径。请填写 tr.exe 的完整路径，或只填写 tr。')
  }

  if (hasSeparator) {
    const extension = commandExtension(command)
    if (platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extension)) {
      const alternative = knownWindowsInstalls(env)
        .map(dir => win32.join(dir, 'tr.exe'))
        .find(candidate => factsOf(candidate) && !isWindowsAppsAlias(candidate))
      throw scriptError(command, alternative)
    }
    if (platform === 'win32' && extension && !WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension)) {
      throw reject(`trCommand 必须指向 .exe 或 .com，当前是 ${extension}。`)
    }
    const facts = factsOf(command)
    if (!facts || isWindowsAppsAlias(command)) {
      throw reject(`找不到可执行文件：${command}。请确认 TokenRouter 已安装，且 trCommand 指向 tr.exe。`)
    }
    return { file: command, kind: 'exe', source: 'configured', skippedScripts: [] }
  }

  if (!BARE_NAME.test(command)) {
    throw reject('trCommand 只能是可执行文件名（例如 tr）或 tr.exe 的完整路径。PowerShell 函数和别名不能被桌面版启动。')
  }

  const directories = []
  const seen = new Set()
  const addDirectory = (dir, source) => {
    if (!dir || seen.has(dir.toLowerCase())) return
    seen.add(dir.toLowerCase())
    directories.push({ dir, source })
  }
  for (const dir of splitPath(environmentValue(env, 'PATH'), platform)) addDirectory(dir, 'path')
  if (platform === 'win32') {
    for (const dir of readRegistryPath({ ...io, platform }, env)) addDirectory(dir, 'registry')
    for (const dir of knownWindowsInstalls(env)) addDirectory(dir, 'known-install')
  }

  const executables = []
  const scripts = []
  for (const entry of directories) {
    const names = platform === 'win32' ? windowsCandidateNames(command) : [command]
    for (const name of names) {
      const candidate = paths.join(entry.dir, name)
      if (isWindowsAppsAlias(candidate) || !factsOf(candidate)) continue
      const extension = commandExtension(candidate)
      if (platform === 'win32' && WINDOWS_SCRIPT_EXTENSIONS.has(extension)) {
        scripts.push(candidate)
      } else if (platform !== 'win32' || WINDOWS_EXECUTABLE_EXTENSIONS.includes(extension) || extension === '') {
        executables.push({ file: candidate, source: entry.source })
      }
    }
  }

  if (executables.length > 0) {
    const selected = executables.find(item => commandExtension(item.file) === '.exe') ?? executables[0]
    return {
      file: selected.file,
      kind: 'exe',
      source: selected.source,
      skippedScripts: [...new Set(scripts)],
    }
  }
  if (scripts.length > 0) throw scriptError(scripts[0])
  if (platform !== 'win32') {
    throw reject(`找不到可执行文件 ${command}。请确认它在 PATH 中，或把 trCommand 设为完整路径。`)
  }
  throw reject(
    '找不到 tr.exe。桌面版的 PATH 可能与当前 PowerShell 不同；PowerShell 函数或别名也不能作为可执行文件启动。'
    + '请在 PowerShell 运行 Get-Command tr，确认它是 tr.exe 后，把该完整路径写入插件配置 trCommand。'
    + '常见安装位置是 %LOCALAPPDATA%\\Programs\\TokenRouter\\tr.exe。',
  )
}
