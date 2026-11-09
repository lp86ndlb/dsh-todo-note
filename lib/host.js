// dsh-todo-note — host half.
//
// Three agent tools, one HTTP surface for the panel, and two prompt sections
// (a static usage guide plus a per-agent live snapshot). The state lives in
// `$DSH_HOME/todo-note/state.json`, one entry per session.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  LIMITS,
  NoteError,
  applyAction,
  emptyNote,
  emptyStore,
  normalizeStore,
  progressOf,
  renderLiveSection,
  pruneStore,
  readText,
  renderSnapshot,
} from './model.js'

export const name = 'todo-note'
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents']

const ROUTE_PREFIX = '/todo-note/api'
const MAX_BODY_BYTES = 64 * 1024
const POLL_DEBOUNCE_MS = 200

const GUIDE = `## Todo note (todo_note)

This session has a draggable sticky note the user watches: short-term tasks ("what now / what next / what is parked") plus a long-term plan with phase progress. It is the shared source of truth between you and the user, and it saves you from re-reading the conversation.

- Before work, \`todo_note_read\` — cheap, and it tells you where the session actually stands.
- As you go, \`todo_note_update\` (focus, add/update/shelve/remove tasks, set_plan). Several small updates beat one big one.
- When a piece of work is finished, \`todo_note_complete\`: it moves the task to "awaiting", and the user ticks it off in the panel. Do not tell the user something is done while it still awaits their confirmation.
- \`set_plan\` replaces the whole plan, so send the complete goal/phase list with honest statuses. Keep phase titles stable — the user sees them as a timeline.
- Keep the note short and current: the user reads it at a glance, and every line costs prompt tokens.
- The list order is the priority order: keep the task the user should do first at the top, and use move_task (or the drag handle in the note) to promote one.
- One task = one concrete action. When a step has several parts, add them as separate tasks (a real checklist); never pack a list of items into one task title.
- Park work with state "shelved" and set \`phase\` to the plan phase it belongs to, so the panel can hang it off that phase as a branch.
- A brand new session is **not linked** yet: the first turn carries a one-line reminder. Link it once (write the focus and 1–3 real tasks with \`todo_note_update\`), and never re-link or repeat the reminder. A linked session stays linked; the panel shows a small “未关联” chip until then. If the user clicks that chip, they are asking you to link now — treat the next turn as that request.
- When the user rejects a task, it returns to active with \`rejects\` > 0 and a "用户未通过" line in the snapshot: that is feedback, so reflect on it and change the approach before calling \`todo_note_complete\` again.
`

function stateFile(config) {
  const override = typeof config?.statePath === 'string' ? config.statePath.trim() : ''
  if (override) return override
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'todo-note', 'state.json')
}

function logWarn(ctx, message, error) {
  try {
    ctx?.logger?.warn?.(`[todo-note] ${message}`, error)
  } catch {
    /* logging must never break the plugin */
  }
}

function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return rename(file, `${file}.corrupt-${stamp}`).catch(() => {})
}

class Store {
  constructor(file, maxSessions) {
    this.file = file
    this.maxSessions = maxSessions
    this.data = emptyStore()
    this.loading = null
    this.timer = null
    this.saving = Promise.resolve()
  }

  ready() {
    if (!this.loading) this.loading = this.load()
    return this.loading
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.data = normalizeStore(JSON.parse(raw))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // A corrupt file must not brick the agent: keep it for inspection and
        // start clean.
        await quarantine(this.file)
        this.data = emptyStore()
      }
    }
  }

  get(sessionId) {
    return this.data.sessions[sessionId] ?? null
  }

  apply(sessionId, action) {
    const current = this.data.sessions[sessionId] ?? emptyNote()
    const { note, changed } = applyAction(current, action)
    this.data.sessions[sessionId] = note
    this.schedule()
    return { note, changed }
  }

  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.save().catch(() => {})
    }, POLL_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  save() {
    // Serialize writes so two debounced saves cannot interleave their rename.
    this.saving = this.saving.then(async () => {
      pruneStore(this.data, this.maxSessions)
      const json = JSON.stringify(this.data)
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await writeFile(tmp, json, 'utf8')
      await replaceFile(tmp, this.file)
    }).catch(() => {})
    return this.saving
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.save()
  }
}

// Windows can hold a transient lock on the target (indexer, AV scanner) and
// fail the rename with EPERM/EBUSY; a short backoff turns that into a no-op.
async function replaceFile(tmp, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      if (attempt >= 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)))
    }
  }
}

function sessionOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.sessionId
  if (typeof id !== 'string' || !id) {
    throw new Error('todo_note_* needs a session; the calling agent has no session id')
  }
  return id
}

function textOut(value) {
  return [{ type: 'text', text: String(value) }]
}

function toolError(error) {
  if (error instanceof NoteError) return `${error.code}: ${error.message}`
  return error?.message ? String(error.message) : String(error)
}

/** Translate `todo_note_update` arguments into model actions. */
function toActions(args) {
  const actions = []
  if (!args || typeof args !== 'object') throw new NoteError('bad-arguments', 'arguments must be an object')

  if (args.focus && typeof args.focus === 'object') {
    actions.push({ type: 'set_focus', current: args.focus.current, next: args.focus.next })
  }
  for (const task of Array.isArray(args.add_tasks) ? args.add_tasks : []) {
    actions.push({ type: 'add_task', title: task?.title, note: task?.note, state: task?.state, phase: task?.phase, by: 'agent' })
  }
  for (const task of Array.isArray(args.update_tasks) ? args.update_tasks : []) {
    actions.push({ type: 'update_task', id: task?.id, title: task?.title, note: task?.note, state: task?.state, phase: task?.phase })
  }
  for (const id of Array.isArray(args.remove_tasks) ? args.remove_tasks : []) {
    actions.push({ type: 'remove_task', id })
  }
  if (args.move_task && typeof args.move_task === 'object') {
    actions.push({ type: 'move_task', id: args.move_task.id, beforeId: args.move_task.beforeId ?? null })
  }
  if (args.set_plan && typeof args.set_plan === 'object') {
    actions.push({ type: 'set_plan', title: args.set_plan.title, goals: args.set_plan.goals, phases: args.set_plan.phases })
  }
  return actions
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function isTrustedRequest(req) {
  const host = req.headers?.host
  if (!host) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const hostname = String(host).replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new NoteError('body-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new NoteError('bad-json', 'request body is not valid JSON')
  }
}

function sessionIdOf(payload) {
  const id = payload?.sessionId
  if (typeof id !== 'string' || !id || id.length > 200) throw new NoteError('bad-session', 'sessionId is required')
  return id
}

export function apply(ctx, config = {}) {
  const options = {
    injectPrompt: config?.injectPrompt !== false,
    injectSnapshot: config?.injectSnapshot !== false,
    maxSessions: Number.isFinite(Number(config?.maxSessions))
      ? Math.min(500, Math.max(10, Math.round(Number(config.maxSessions))))
      : LIMITS.sessions,
    statePath: stateFile(config),
  }
  const store = new Store(options.statePath, options.maxSessions)
  store.ready().catch((error) => logWarn(ctx, 'state load failed', error))

  // Persist anything still queued when the plugin unmounts (disable, HMR).
  ctx.effect(() => () => {
    store.flush().catch(() => {})
  }, 'todo-note-flush')

  // ---------------------------------------------------------------- tools --
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'todo_note_read',
        description:
          "Read this session's todo note: focus (what you are doing now / the next step), short-term tasks with ids and states, the long-term plan with phase progress, and recently completed items. Call it before starting work or when the user asks about progress; it is cheaper than re-reading the conversation.",
        parameters: { type: 'object', properties: {}, required: [] },
        output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
        timeoutMs: 10_000,
        async execute(_args, exec) {
          const sessionId = sessionOf(exec)
          await store.ready()
          const note = store.get(sessionId) ?? emptyNote()
          return readText(note, sessionId)
        },
      }),
    'todo-note-tool-read',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'todo_note_update',
        description:
          "Update this session's todo note. Use it as you work: change focus when you switch steps, add tasks you discover, shelve what you park, and advance the long-term plan. `set_plan` REPLACES the entire plan, so send the full goal/phase list (keep phase titles stable). Prefer several small updates over one big one — the panel animates each change.",
        parameters: {
          type: 'object',
          properties: {
            focus: {
              type: 'object',
              description: 'What you are doing right now and what comes next.',
              properties: {
                current: { type: 'string', description: 'Current step, one short phrase.' },
                next: { type: 'string', description: 'The next step after the current one.' },
              },
              required: [],
            },
            add_tasks: {
              type: 'array',
              description: 'New short-term tasks, newest first in the panel.',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Short imperative title (<= 200 chars).' },
                  note: { type: 'string', description: 'Optional detail the user should see.' },
                  state: { type: 'string', enum: ['active', 'shelved'], description: 'Defaults to active.' },
                  phase: { type: 'string', description: 'Optional plan phase (title or id) this task belongs to; shelved tasks hang off that phase as a branch.' },
                },
                required: ['title'],
              },
            },
            update_tasks: {
              type: 'array',
              description: 'Edit existing tasks by id. To finish one use todo_note_complete instead.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Task id from todo_note_read.' },
                  title: { type: 'string' },
                  note: { type: 'string' },
                  state: { type: 'string', enum: ['active', 'shelved'] },
                  phase: { type: 'string', description: 'Move the task under another plan phase (title or id).' },
                },
                required: ['id'],
              },
            },
            remove_tasks: {
              type: 'array',
              description: 'Delete tasks by id (for mistakes, not for completed work).',
              items: { type: 'string' },
            },
            move_task: {
              type: 'object',
              description: 'Reorder one task: the list order is the priority order. Put it before beforeId, or at the end with beforeId null.',
              properties: {
                id: { type: 'string' },
                beforeId: { type: ['string', 'null'], description: 'Id of the task it should sit before; null means last.' },
              },
              required: ['id'],
            },
            set_plan: {
              type: 'object',
              description: 'Replace the long-term plan. Omitting goals/phases keeps the current list.',
              properties: {
                title: { type: 'string', description: 'Plan title, e.g. the project name.' },
                goals: {
                  type: 'array',
                  description: 'Final goals; strings or {text, done}.',
                  items: {},
                },
                phases: {
                  type: 'array',
                  description: 'Ordered phases. status is todo|active|done; weight (0.5-5) is the share of the total progress bar.',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      status: { type: 'string', enum: ['todo', 'active', 'done'] },
                      weight: { type: 'number' },
                    },
                    required: ['title'],
                  },
                },
              },
              required: [],
            },
          },
          required: [],
        },
        output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
        timeoutMs: 10_000,
        async execute(args, exec) {
          const sessionId = sessionOf(exec)
          await store.ready()
          const actions = toActions(args)
          if (actions.length === 0) {
            throw new NoteError('nothing-to-do', 'pass at least one of focus, add_tasks, update_tasks, remove_tasks, move_task or set_plan')
          }
          let note = store.get(sessionId) ?? emptyNote()
          for (const action of actions) {
            try {
              note = store.apply(sessionId, action).note
            } catch (error) {
              throw new Error(`${toolError(error)}${actions.length > 1 ? ' (earlier actions in this call were applied)' : ''}`)
            }
          }
          return readText(note, sessionId)
        },
      }),
    'todo-note-tool-update',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'todo_note_complete',
        description:
          'Offer a finished task to the user. This moves the task to "awaiting" and the panel shows an inline ✓/✗ confirm; only the user\'s ✓ strikes it out and moves it to recently-done. Call it as soon as the work is done, then continue with the next task.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Task id from todo_note_read.' },
            note: { type: 'string', description: 'Optional one-line result summary shown with the task.' },
          },
          required: ['id'],
        },
        output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
        timeoutMs: 10_000,
        async execute(args, exec) {
          const sessionId = sessionOf(exec)
          await store.ready()
          if (args?.note) {
            try {
              store.apply(sessionId, { type: 'update_task', id: args.id, note: args.note })
            } catch {
              /* the note is cosmetic; complete below reports real problems */
            }
          }
          const { note } = store.apply(sessionId, { type: 'complete_task', id: args?.id })
          return `${readText(note, sessionId)}\n\n→ "${args?.id}" is awaiting the user's confirmation in the panel.`
        },
      }),
    'todo-note-tool-complete',
  )

  // --------------------------------------------------------------- routes --
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            if (!isTrustedRequest(req)) {
              sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
              return
            }
            const method = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(`${ROUTE_PREFIX}/`.length)
            const payload = await readJsonBody(req)
            await store.ready()

            if (method === 'get') {
              const sessionId = sessionIdOf(payload)
              const note = store.get(sessionId) ?? emptyNote()
              const since = Number(payload?.since)
              if (Number.isFinite(since) && since === note.version) {
                sendJson(res, 200, { ok: true, value: { unchanged: true, version: note.version } })
                return
              }
              sendJson(res, 200, { ok: true, value: { version: note.version, note } })
              return
            }

            if (method === 'act') {
              const sessionId = sessionIdOf(payload)
              const action = payload?.action
              if (!action || typeof action !== 'object') {
                throw new NoteError('bad-action', 'action is required')
              }
              // Panel actions run through the same model as the tools; the `by`
              // tag is forced to `user` so the note shows who added what.
              const { note } = store.apply(sessionId, { ...action, by: action.by === 'agent' ? 'agent' : 'user' })
              sendJson(res, 200, { ok: true, value: { version: note.version, note } })
              return
            }

            sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method ${method}` } })
          } catch (error) {
            const code = error instanceof NoteError ? error.code : 'internal'
            const status = error instanceof NoteError ? 400 : 500
            sendJson(res, status, { ok: false, error: { code, message: toolError(error) } })
          }
        },
      }),
    'todo-note-route',
  )

  // -------------------------------------------------------------- prompts --
  if (options.injectPrompt) {
    ctx.effect(
      () => ctx.systemPrompt.section({ name: 'todo-note.guide', order: 40, text: GUIDE }),
      'todo-note-guide',
    )
  }

  if (options.injectSnapshot) {
    const onCreated = (payload) => {
      try {
        const agent = payload?.agent ?? payload
        const agentId = agent?.id
        const agentCtx = agent?.ctx
        const systemPrompt = agentCtx?.systemPrompt
        if (!agentId || !agentCtx || typeof systemPrompt?.section !== 'function') return
        const register = () =>
          systemPrompt.section({
            name: 'todo-note.live',
            order: 41,
            text: () => {
              try {
                const note = store.get(agentId)
                if (!note) return ''
                return renderLiveSection(note, { nudge: options.nudgeLinked !== false })
              } catch {
                return ''
              }
            },
          })
        // Prefer the agent scope so the section disposes with the agent; fall
        // back to a plain registration when `effect` is unavailable.
        if (typeof agentCtx.effect === 'function') agentCtx.effect(register, 'todo-note-live')
        else register()
      } catch (error) {
        logWarn(ctx, 'failed to attach live snapshot', error)
      }
    }
    ctx.effect(() => ctx.on('agent/created', onCreated), 'todo-note-live-listener')
    // Sessions that were already running when the plugin loaded.
    try {
      for (const agent of ctx.agents?.list?.() ?? []) onCreated({ agent })
    } catch (error) {
      logWarn(ctx, 'failed to attach the live snapshot to running agents', error)
    }
  }
}
