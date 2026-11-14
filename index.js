/**
 * Mise environments for DeepSeek Harness.
 *
 * Adds three model-facing tools around the mise CLI:
 * - `mise_status` inspects the project config, lockfile, tools, and tasks.
 * - `mise_prepare` installs the declared tools, optionally refreshing `mise.lock`.
 * - `mise_run` runs a command or task inside the project's mise environment.
 *
 * Commands go through the Harness `shell` service, so the Session's sandbox
 * policy applies. Under `workspace-write`, mise's own data, cache, config and
 * state directories are granted for the duration of an operation: installing a
 * tool writes there, not in the workspace.
 *
 * @module dsh-mise-env
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'mise-env'

/** Services used by the plugin. */
export const inject = ['tools', 'shell', 'workingDirectory', 'systemPrompt']

/** Runtime configuration schema; every field has a default. */
export const Config = Schema.object({
  misePath: Schema.string().default('mise'),
  promptGuidance: Schema.boolean().default(true),
  grantMiseWritableRoots: Schema.boolean().default(true),
  commandTimeoutMs: Schema.number().default(120_000),
  installTimeoutMs: Schema.number().default(900_000),
})

const GUIDANCE = 'Project environments may be managed by mise (`mise.toml` plus `mise.lock`). '
  + 'Use mise_status before assuming a project runtime is available, and run project builds, tests, and scripts with mise_run so they use the project environment. '
  + 'Use mise_prepare to make the environment ready, and keep mise.lock committed. '
  + 'Do not install or switch project tool versions globally.'

const MAX_JSON_OUTPUT = 16_000
const MAX_RENDERED_COMMAND = 4_000

/** Results from `mise doctor --json`, keyed by the configured mise executable. */
const doctorDirsCache = new Map()

function quoteShell(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function miseCommand(misePath, args) {
  return [quoteShell(misePath), ...args.map(quoteShell)].join(' ')
}

function tail(text, max) {
  if (text.length <= max) return text
  return `[... ${text.length - max} characters omitted ...]\n${text.slice(-max)}`
}

function combinedOutput(result) {
  const parts = []
  if (result.stdout.text.length > 0) parts.push(result.stdout.text.trimEnd())
  if (result.stderr.text.length > 0) parts.push(`[stderr]\n${result.stderr.text.trimEnd()}`)
  return parts.join('\n')
}

function sandboxMode(ctx, exec) {
  try {
    const service = ctx.get('sandboxPolicy')
    if (service === undefined) return undefined
    return service.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }).mode
  } catch {
    return undefined
  }
}

function defaultMiseDirs() {
  const home = homedir()
  return [
    process.env.MISE_DATA_DIR ?? join(home, '.local', 'share', 'mise'),
    process.env.MISE_CACHE_DIR ?? join(home, '.cache', 'mise'),
    process.env.MISE_CONFIG_DIR ?? join(home, '.config', 'mise'),
    process.env.MISE_STATE_DIR ?? join(home, '.local', 'state', 'mise'),
  ]
}

/**
 * Run one shell command with the Session's sandbox policy. Writable roots are
 * registered only for the duration of this operation, then disposed.
 */
async function shellCommand(ctx, exec, options) {
  const session = exec.agent?.session
  const policyService = ctx.get('sandboxPolicy')
  const disposers = []
  try {
    if (session !== undefined && policyService !== undefined && (options.writableRoots?.length ?? 0) > 0) {
      for (const directory of options.writableRoots) {
        try {
          if (!(await stat(directory)).isDirectory()) continue
          disposers.push(policyService.registerWritableRoot(session, directory))
        } catch {
          // A missing or symlinked directory cannot be granted; mise reports the
          // resulting denial normally.
        }
      }
    }
    const policy = policyService?.resolve(session === undefined ? {} : { session })
    const spec = ctx.shell.resolve({
      command: options.command,
      workdir: options.workdir,
      timeoutMs: options.timeoutMs,
      signal: exec.signal,
      ...(policy === undefined ? {} : { sandboxPolicy: policy }),
      stdoutMaxBytes: 262_144,
    })
    const execution = await ctx.shell.execute(spec)
    return await execution.result()
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // Disposal is best effort at the end of the operation.
      }
    }
  }
}

async function resolveWorkdir(ctx, exec, requested) {
  if (exec.agent === undefined) throw new ToolContextUnavailableError('mise tools require an agent Session')
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  if (requested === undefined) return cwd
  if (requested.trim() === '') throw new ToolArgsError(['workdir must not be empty'])
  const target = isAbsolute(requested) ? requested : resolve(cwd, requested)
  try {
    if (!(await stat(target)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new ToolArgsError([`workdir is not an existing directory: ${target}`])
  }
  return target
}

function miseFailure(config, action, command, result) {
  const detail = combinedOutput(result)
  if (result.exitCode === 127 || /command not found/i.test(detail)) {
    return new Error(`mise executable "${config.misePath}" was not found on PATH. Install mise (https://mise.jdx.dev) or set misePath in the plugin configuration.`)
  }
  return new Error(`mise ${action} failed (exit ${result.exitCode}):\n${tail(detail || '(no output)', 2_000)}\n$ ${command}`)
}

async function runMise(ctx, exec, config, options) {
  const command = miseCommand(config.misePath, options.args)
  const result = await shellCommand(ctx, exec, {
    command,
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
    writableRoots: options.writableRoots ?? [],
  })
  return { command, display: [config.misePath, ...options.args].join(' '), result }
}

async function doctorDirs(ctx, exec, config, workdir) {
  let cached = doctorDirsCache.get(config.misePath)
  if (cached === undefined) {
    cached = (async () => {
      try {
        const { result } = await runMise(ctx, exec, config, {
          args: ['doctor', '--json'],
          workdir,
          timeoutMs: 30_000,
        })
        if (result.exitCode === 0) {
          const parsed = JSON.parse(result.stdout.text)
          const dirs = [parsed?.dirs?.data, parsed?.dirs?.cache, parsed?.dirs?.config, parsed?.dirs?.state]
            .filter(directory => typeof directory === 'string' && directory.length > 0)
          if (dirs.length > 0) return [...new Set(dirs)]
        }
      } catch {
        // Fall back to the conventional locations below.
      }
      return defaultMiseDirs()
    })()
    doctorDirsCache.set(config.misePath, cached)
  }
  return cached
}

async function writableRootsFor(ctx, exec, config, workdir) {
  if (!config.grantMiseWritableRoots || sandboxMode(ctx, exec) !== 'workspace-write') return []
  return doctorDirs(ctx, exec, config, workdir)
}

function parseTrust(text) {
  const entries = []
  for (const line of text.split('\n')) {
    const match = /^(.*): (trusted|untrusted|ignored)$/.exec(line.trim())
    if (match !== null) entries.push({ path: match[1], trust: match[2] })
  }
  return entries
}

async function detectProject(ctx, exec, config, workdir) {
  const { command, result } = await runMise(ctx, exec, config, {
    args: ['trust', '--show'],
    workdir,
    timeoutMs: 30_000,
  })
  if (result.exitCode !== 0) throw miseFailure(config, 'config inspection', command, result)
  const configs = parseTrust(result.stdout.text)
  if (configs.length === 0) return { configs, project: undefined }
  return { configs, project: { root: configs[configs.length - 1].path } }
}

function parseToolList(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const tools = []
  for (const [name, entries] of Object.entries(parsed)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      tools.push({
        name,
        request: String(entry?.requested_version ?? entry?.version ?? ''),
        version: String(entry?.version ?? ''),
        installed: entry?.installed === true,
      })
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name) || a.request.localeCompare(b.request))
  return tools
}

function parseTaskTools(text, root) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const specs = new Set()
  for (const task of parsed) {
    if (typeof task?.name !== 'string' || task.tools === null || typeof task.tools !== 'object') continue
    if (typeof task.source === 'string') {
      const rel = relative(root, task.source)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
    }
    if (Array.isArray(task.tools)) {
      for (const spec of task.tools) if (typeof spec === 'string' && spec.length > 0) specs.add(spec)
      continue
    }
    for (const [name, value] of Object.entries(task.tools)) {
      const versions = Array.isArray(value) ? value : [value]
      for (const version of versions) {
        const resolved = typeof version === 'object' && version !== null ? version.version : version
        if (typeof resolved === 'string' && resolved.length > 0) specs.add(`${name}@${resolved}`)
      }
    }
  }
  return [...specs]
}

function parseTaskList(text, root) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const tasks = []
  for (const task of parsed) {
    if (typeof task?.name !== 'string') continue
    if (typeof task.source === 'string') {
      const rel = relative(root, task.source)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
    }
    tasks.push({
      name: task.name,
      ...(typeof task.description === 'string' && task.description.length > 0 ? { description: task.description } : {}),
    })
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name))
  return tasks
}

async function findLockfile(root) {
  const path = join(root, 'mise.lock')
  try {
    if ((await stat(path)).isFile()) return path
  } catch {
    // Absent lockfile is a normal state.
  }
  return undefined
}

function limit(items, max) {
  return { items: items.slice(0, max), total: items.length, truncated: items.length > max }
}

function toolLine(tool) {
  const resolved = tool.version.length > 0 && tool.version !== tool.request ? ` -> ${tool.version}` : ''
  return `${tool.name} ${tool.request}${resolved}${tool.installed ? ' installed' : ' MISSING'}`
}

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    request: { type: 'string', required: true },
    version: { type: 'string', required: true },
    installed: { type: 'boolean', required: true },
  },
}

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    description: { type: 'string' },
  },
}

const COMMAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
    timedOut: { type: 'boolean', required: true },
    output: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
  },
}

/**
 * Register the mise tools and the prompt guidance.
 * @param ctx - context providing tools, shell, working directory, and prompt.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config = {}) {
  const settings = {
    misePath: config.misePath ?? 'mise',
    promptGuidance: config.promptGuidance ?? true,
    grantMiseWritableRoots: config.grantMiseWritableRoots ?? true,
    commandTimeoutMs: config.commandTimeoutMs ?? 120_000,
    installTimeoutMs: config.installTimeoutMs ?? 900_000,
  }
  if (!Number.isFinite(settings.commandTimeoutMs) || settings.commandTimeoutMs <= 0) {
    throw new Error('mise-env: commandTimeoutMs must be a positive number')
  }
  if (!Number.isFinite(settings.installTimeoutMs) || settings.installTimeoutMs <= 0) {
    throw new Error('mise-env: installTimeoutMs must be a positive number')
  }
  if (typeof settings.misePath !== 'string' || settings.misePath.trim() === '') {
    throw new Error('mise-env: misePath must be a non-empty string')
  }

  if (settings.promptGuidance) {
    ctx.systemPrompt.section({
      name: 'tool:mise-env',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
      text: GUIDANCE,
    })
  }

  ctx.tools.register(defineTool({
    name: 'mise_status',
    description: 'Inspect the mise project that applies from the session directory: config roots and their trust state, whether mise.lock is present, the declared tools with installed/missing status, and the project tasks. Read-only; use mise_prepare to install missing tools. A directory without a mise config reports that no project applies rather than failing.',
    parameters: {
      workdir: { type: 'string', description: 'Project directory to inspect. Defaults to the session working directory; a relative path is resolved against it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isProject: { type: 'boolean', required: true },
          cwd: { type: 'string', required: true },
          projectRoot: { type: 'string' },
          configRoots: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                trust: { type: 'string', required: true },
              },
            },
          },
          lockfile: { type: 'string' },
          tools: { type: 'array', required: true, items: TOOL_SCHEMA },
          tasks: { type: 'array', required: true, items: TASK_SCHEMA },
          ready: { type: 'boolean', required: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = []
        if (!value.isProject) {
          lines.push(`no mise project configured from ${value.cwd}`)
          lines.push('Create mise.toml in the project root to pin its tools and environment.')
        } else {
          lines.push(`mise project: ${value.projectRoot}`)
          lines.push(`config roots: ${value.configRoots.map(root => `${root.path} (${root.trust})`).join(', ')}`)
          lines.push(`lockfile: ${value.lockfile ?? 'missing'}`)
          const trusted = value.configRoots.every(root => root.trust === 'trusted')
          if (!trusted) {
            lines.push('tools: unknown (config untrusted)')
            lines.push('tasks: unknown (config untrusted)')
          } else {
            lines.push(value.tools.length === 0 ? 'tools: none declared' : 'tools:')
            for (const tool of value.tools) lines.push(`- ${toolLine(tool)}`)
            lines.push(value.tasks.length === 0 ? 'tasks: none' : `tasks: ${value.tasks.map(task => task.name).join(', ')}`)
          }
          const state = value.ready
            ? (value.lockfile === undefined ? 'ready (no lockfile)' : 'ready (lockfile present)')
            : 'not ready'
          lines.push(`state: ${state}`)
        }
        if (value.notes.length > 0) {
          lines.push('notes:')
          for (const note of value.notes) lines.push(`- ${note}`)
        }
        return [{ type: 'text', text: tail(lines.join('\n'), MAX_JSON_OUTPUT) }]
      },
    },
    async execute(args, exec) {
      const workdir = await resolveWorkdir(ctx, exec, args.workdir)
      const detected = await detectProject(ctx, exec, settings, workdir)
      if (detected.project === undefined) {
        return {
          isProject: false,
          cwd: workdir,
          configRoots: [],
          tools: [],
          tasks: [],
          ready: false,
          notes: ['No mise config was found in this directory or its parents.'],
        }
      }
      const root = detected.project.root
      const notes = []
      const untrusted = detected.configs.filter(root => root.trust !== 'trusted')
      let tools = []
      let tasks = []
      let taskTools = []
      if (untrusted.length === 0) {
        const [toolsRun, tasksRun] = await Promise.all([
          runMise(ctx, exec, settings, { args: ['ls', '--project', '--json'], workdir, timeoutMs: 30_000 }),
          runMise(ctx, exec, settings, { args: ['tasks', 'ls', '--json'], workdir, timeoutMs: 30_000 }),
        ])
        if (toolsRun.result.exitCode === 0) {
          const parsed = parseToolList(toolsRun.result.stdout.text)
          if (parsed === undefined) {
            notes.push('could not parse `mise ls --json` output')
          } else {
            tools = parsed
          }
        } else {
          notes.push(`could not list tools: ${tail(combinedOutput(toolsRun.result) || 'unknown error', 500)}`)
        }
        if (tasksRun.result.exitCode === 0) {
          tasks = parseTaskList(tasksRun.result.stdout.text, root)
          taskTools = parseTaskTools(tasksRun.result.stdout.text, root)
        } else {
          notes.push(`could not list tasks: ${tail(combinedOutput(tasksRun.result) || 'unknown error', 500)}`)
        }
      } else {
        notes.push(`The config is untrusted (${untrusted.map(entry => entry.path).join(', ')}), so mise will not parse its tools or tasks. Review mise.toml, then run mise_prepare with trust:true.`)
      }
      const limitedTools = limit(tools, 80)
      const limitedTasks = limit(tasks, 80)
      if (limitedTools.truncated) notes.push(`showing 80 of ${limitedTools.total} tool entries`)
      if (limitedTasks.truncated) notes.push(`showing 80 of ${limitedTasks.total} tasks`)

      const lockfile = await findLockfile(root)
      if (lockfile === undefined) {
        if (untrusted.length > 0) {
          notes.push('no mise.lock: after trusting the config, run mise_prepare with lock:true to pin tool versions.')
        } else if (tools.length === 0) {
          notes.push('no project tools are declared, so no lockfile is needed.')
        } else {
          notes.push('no mise.lock: versions are resolved from mise.toml; run mise_prepare with lock:true to pin them.')
        }
      }
      if (taskTools.length > 0) {
        notes.push(`${taskTools.length} tool(s) are required by tasks and are not listed above; mise_prepare installs them and mise_run activates them per task.`)
      }
      const missing = tools.filter(tool => !tool.installed)
      if (missing.length > 0) {
        notes.push(`${missing.length} tool(s) missing: ${missing.map(tool => `${tool.name} ${tool.request}`).join(', ')}. Run mise_prepare.`)
      }
      const ready = missing.length === 0 && untrusted.length === 0
      if (ready && lockfile !== undefined) {
        notes.push('Environment tools are installed; mise.lock is present (mise_prepare verifies it with --locked).')
      }
      return {
        isProject: true,
        cwd: workdir,
        projectRoot: root,
        configRoots: detected.configs,
        ...(lockfile === undefined ? {} : { lockfile }),
        tools: limitedTools.items,
        tasks: limitedTasks.items,
        ready,
        notes,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mise_prepare',
    description: 'Install the project tools declared by mise, plus tools required by its tasks, and verify that no project tool is missing. Installs with --locked whenever mise.lock exists, so a stale lockfile fails instead of resolving new versions; set `lock` to create or refresh the lockfile first. Set `trust` to mark the config trusted first; trust is persisted and lets mise load config parts that can run code or change the environment. A failed install is returned as a command result, not a tool error.',
    parameters: {
      workdir: { type: 'string', description: 'Project directory. Defaults to the session working directory; a relative path is resolved against it.' },
      lock: { type: 'boolean', description: 'Create or refresh mise.lock before installing. Installs use --locked whenever a lockfile exists; use this after changing [tools] or when install reports a stale lockfile.' },
      trust: { type: 'boolean', description: 'Run mise trust first. Trust is persisted and lets mise load config parts that can run code or change the environment; review mise.toml before enabling.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          cwd: { type: 'string', required: true },
          projectRoot: { type: 'string', required: true },
          lockfile: { type: 'string' },
          commands: { type: 'array', required: true, items: COMMAND_SCHEMA },
          missing: { type: 'array', required: true, items: TOOL_SCHEMA },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [`mise prepare: ${value.projectRoot}`]
        for (const command of value.commands) {
          lines.push(`$ ${command.command}`)
          const output = command.output.trimEnd()
          if (output.length > 0) lines.push(tail(output, MAX_RENDERED_COMMAND))
          const markers = []
          if (command.timedOut) markers.push('[timed out]')
          if (!command.timedOut && command.exitCode !== 0 && command.exitCode !== null) markers.push(`[exit code: ${command.exitCode}]`)
          if (markers.length > 0) lines.push(markers.join(' '))
        }
        lines.push(`result: ${value.ok ? 'ok' : 'failed'}`)
        lines.push(value.lockfile === undefined ? 'lockfile: missing' : `lockfile: ${value.lockfile}`)
        if (value.missing.length > 0) {
          lines.push(`still missing: ${value.missing.map(tool => `${tool.name} ${tool.request}`).join(', ')}`)
        }
        if (value.notes.length > 0) {
          lines.push('notes:')
          for (const note of value.notes) lines.push(`- ${note}`)
        }
        return [{ type: 'text', text: tail(lines.join('\n'), MAX_JSON_OUTPUT) }]
      },
    },
    async execute(args, exec) {
      const workdir = await resolveWorkdir(ctx, exec, args.workdir)
      const detected = await detectProject(ctx, exec, settings, workdir)
      if (detected.project === undefined) {
        throw new ToolArgsError([`no mise config found from ${workdir}; create mise.toml in the project root first`])
      }
      const root = detected.project.root
      const untrusted = detected.configs.filter(entry => entry.trust !== 'trusted')
      const roots = await writableRootsFor(ctx, exec, settings, workdir)
      const commands = []
      const notes = []
      const record = (command, result) => {
        const output = combinedOutput(result)
        commands.push({
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: tail(output, 12_000),
          truncated: output.length > 12_000,
        })
      }
      const fail = async (failNotes) => {
        const currentLockfile = await findLockfile(root)
        return {
          ok: false,
          cwd: workdir,
          projectRoot: root,
          ...(currentLockfile === undefined ? {} : { lockfile: currentLockfile }),
          commands,
          missing: [],
          notes: failNotes,
        }
      }

      if (args.trust === true) {
        const run = await runMise(ctx, exec, settings, { args: ['trust'], workdir, timeoutMs: 60_000, writableRoots: roots })
        record(run.display, run.result)
        if (run.result.exitCode !== 0) {
          notes.push('mise trust failed; fix the reported problem and retry.')
          return fail(notes)
        }
      }

      if (args.lock === true) {
        const run = await runMise(ctx, exec, settings, { args: ['lock'], workdir, timeoutMs: settings.installTimeoutMs, writableRoots: roots })
        record(run.display, run.result)
        if (run.result.exitCode !== 0) {
          if (untrusted.length > 0 && args.trust !== true) {
            notes.push('The config is untrusted; review mise.toml, then retry with trust:true.')
          }
          notes.push('mise lock failed; fix the reported problem and retry.')
          return fail(notes)
        }
      }

      const projectToolsRun = await runMise(ctx, exec, settings, { args: ['ls', '--project', '--json'], workdir, timeoutMs: 30_000, writableRoots: roots })
      const projectTools = projectToolsRun.result.exitCode === 0
        ? parseToolList(projectToolsRun.result.stdout.text) ?? []
        : []
      if (projectToolsRun.result.exitCode !== 0) {
        const detail = tail(combinedOutput(projectToolsRun.result) || 'unknown error', 500)
        notes.push(untrusted.length > 0 && args.trust !== true
          ? 'The config is untrusted; review mise.toml, then retry with trust:true.'
          : `could not read project tools: ${detail}`)
        return fail(notes)
      }

      const tasksRun = await runMise(ctx, exec, settings, { args: ['tasks', 'ls', '--json'], workdir, timeoutMs: 30_000, writableRoots: roots })
      let taskToolSpecs = []
      if (tasksRun.result.exitCode === 0) {
        taskToolSpecs = parseTaskTools(tasksRun.result.stdout.text, root)
      } else {
        notes.push(`could not read task tools: ${tail(combinedOutput(tasksRun.result) || 'unknown error', 500)}`)
      }
      const toolSpecs = [...new Set([
        ...projectTools.map(tool => `${tool.name}@${tool.request}`),
        ...taskToolSpecs,
      ])]
      if (taskToolSpecs.length > 0) {
        notes.push(`including ${taskToolSpecs.length} tool(s) required by project tasks.`)
      }
      const lockfile = await findLockfile(root)
      let install
      if (toolSpecs.length > 0) {
        const installArgs = ['install', ...(lockfile === undefined ? [] : ['--locked']), ...toolSpecs]
        install = await runMise(ctx, exec, settings, { args: installArgs, workdir, timeoutMs: settings.installTimeoutMs, writableRoots: roots })
        record(install.display, install.result)
      } else {
        notes.push('no tools are declared in [tools] or by tasks; nothing to install.')
      }

      let missing = []
      let verified = false
      const verify = await runMise(ctx, exec, settings, { args: ['ls', '--project', '--missing', '--json'], workdir, timeoutMs: 30_000, writableRoots: roots })
      if (verify.result.exitCode === 0) {
        missing = parseToolList(verify.result.stdout.text) ?? []
        verified = true
      } else {
        notes.push(`could not verify installed tools: ${tail(combinedOutput(verify.result) || 'unknown error', 500)}`)
      }

      if (lockfile === undefined) {
        if (toolSpecs.length === 0) {
          notes.push('no [tools] are declared, so there are no versions to pin in a lockfile.')
        } else if (args.lock === true) {
          notes.push('mise lock did not produce a lockfile; check its output above.')
        } else {
          notes.push('no lockfile was written; run mise_prepare with lock:true to pin versions and make installs reproducible.')
        }
      }
      if (install !== undefined && install.result.exitCode !== 0) {
        if (untrusted.length > 0 && args.trust !== true) {
          notes.push('The config is untrusted; review mise.toml, then retry with trust:true.')
        }
        notes.push(lockfile === undefined
          ? 'mise install failed; review the output above.'
          : 'mise install --locked failed; if mise.lock is out of date, run mise_prepare with lock:true.')
      }
      if (missing.length > 0) {
        notes.push(`${missing.length} tool(s) are still missing: ${missing.map(tool => `${tool.name} ${tool.request}`).join(', ')}.`)
      }
      const ok = verified && (install === undefined || install.result.exitCode === 0) && missing.length === 0
      if (ok) notes.push('Environment ready.')
      return {
        ok,
        cwd: workdir,
        projectRoot: root,
        ...(lockfile === undefined ? {} : { lockfile }),
        commands,
        missing,
        notes,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mise_run',
    description: 'Run a shell command or a mise task inside the project\'s mise environment. Use this instead of bash for builds, tests, and scripts so they use the versions pinned in mise.toml and mise.lock and the `[env]` it declares. `command` supports pipes and redirection; `task` runs `mise run` with optional `args`. Output is combined stdout/stderr; a nonzero exit is returned as [exit code: N], not a tool error. Runs under the session sandbox; set `workdir` for a subproject. Without a mise project it still applies the global mise environment.',
    parameters: {
      command: { type: 'string', description: 'Shell command to run with mise\'s environment (supports pipes and redirection). Provide exactly one of command or task.' },
      task: { type: 'string', description: 'mise task to run with `mise run`. Provide exactly one of command or task.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the task; only valid with task.' },
      workdir: { type: 'string', description: 'Directory to run in. Defaults to the session working directory; a relative path is resolved against it.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const body = [value.stdout.trimEnd(), value.stderr.trimEnd()].filter(text => text.length > 0).join('\n')
        const markers = []
        if (value.aborted) markers.push('[aborted]')
        if (value.timedOut) markers.push('[timed out]')
        if (!value.timedOut && !value.aborted && value.exitCode !== 0 && value.exitCode !== null) markers.push(`[exit code: ${value.exitCode}]`)
        if (!value.aborted && value.signal !== null) markers.push(`[signal: ${value.signal}]`)
        const text = [body.length > 0 ? body : '(no output)', ...markers].join('\n')
        return [{ type: 'text', text: tail(text, MAX_JSON_OUTPUT) }]
      },
    },
    async execute(args, exec) {
      const hasCommand = typeof args.command === 'string' && args.command.trim().length > 0
      const hasTask = typeof args.task === 'string' && args.task.trim().length > 0
      if (hasCommand === hasTask) throw new ToolArgsError(['provide exactly one of command or task'])
      if (args.args !== undefined && !hasTask) throw new ToolArgsError(['args is only valid with task'])
      if (args.args !== undefined && !args.args.every(argument => typeof argument === 'string')) {
        throw new ToolArgsError(['args must contain only strings'])
      }
      if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
        throw new ToolArgsError([`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`])
      }
      const workdir = await resolveWorkdir(ctx, exec, args.workdir)
      const roots = await writableRootsFor(ctx, exec, settings, workdir)
      const runArgs = hasTask
        ? ['run', args.task, ...(args.args === undefined || args.args.length === 0 ? [] : ['--', ...args.args])]
        : ['exec', '-c', args.command]
      const result = await shellCommand(ctx, exec, {
        command: miseCommand(settings.misePath, runArgs),
        workdir,
        timeoutMs: args.timeoutMs ?? settings.commandTimeoutMs,
        writableRoots: roots,
      })
      return {
        command: [settings.misePath, ...runArgs].join(' '),
        cwd: workdir,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdout: tail(result.stdout.text, MAX_JSON_OUTPUT),
        stderr: tail(result.stderr.text, MAX_JSON_OUTPUT),
      }
    },
  }))
}
