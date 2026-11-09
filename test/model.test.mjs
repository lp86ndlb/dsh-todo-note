import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LIMITS,
  NoteError,
  applyAction,
  countsOf,
  emptyNote,
  isLinked,
  normalizeStore,
  progressOf,
  pruneStore,
  readText,
  renderLiveSection,
  renderSnapshot,
} from '../lib/model.js'

const run = (note, action) => applyAction(note, action).note

test('empty note is inert', () => {
  const note = emptyNote()
  assert.equal(note.version, 0)
  assert.deepEqual(note.tasks, [])
  assert.match(renderSnapshot(note), /暂无待办/)
  assert.match(readText(note, 'sess-1234567'), /\(empty/)
})

test('add_task prepends, tags the author and bumps the version', () => {
  let note = emptyNote()
  note = run(note, { type: 'add_task', title: '  写 host 半边  ', by: 'agent' })
  note = run(note, { type: 'add_task', title: '用户自己加的', by: 'user' })
  assert.equal(note.version, 2)
  assert.equal(note.tasks.length, 2)
  assert.equal(note.tasks[0].title, '用户自己加的')
  assert.equal(note.tasks[0].by, 'user')
  assert.equal(note.tasks[1].title, '写 host 半边')
  assert.equal(note.tasks[1].state, 'active')
})

test('add_task rejects empty titles and enforces the cap', () => {
  assert.throws(() => applyAction(emptyNote(), { type: 'add_task', title: '   ' }), (err) => err instanceof NoteError && err.code === 'empty-title')
  let note = emptyNote()
  for (let i = 0; i < LIMITS.tasks; i += 1) note = run(note, { type: 'add_task', title: `t${i}` })
  assert.throws(() => applyAction(note, { type: 'add_task', title: 'overflow' }), (err) => err.code === 'too-many-tasks')
})

test('titles are trimmed and clipped', () => {
  const long = 'x'.repeat(LIMITS.title + 40)
  const note = run(emptyNote(), { type: 'add_task', title: long })
  assert.equal(note.tasks[0].title.length, LIMITS.title)
  assert.ok(note.tasks[0].title.endsWith('…'))
})

test('complete_task only asks the user, confirm_task strikes it out', () => {
  let note = run(emptyNote(), { type: 'add_task', title: 'step' })
  const id = note.tasks[0].id

  note = run(note, { type: 'complete_task', id })
  assert.equal(note.tasks[0].state, 'awaiting')
  assert.equal(countsOf(note).awaiting, 1)

  // Repeated complete_task is idempotent: it must not bump the version.
  const versionBefore = note.version
  const again = applyAction(note, { type: 'complete_task', id })
  assert.equal(again.note.version, versionBefore)
  assert.equal(again.changed.awaiting, true)

  note = run(note, { type: 'confirm_task', id })
  assert.equal(note.tasks.length, 0)
  assert.equal(note.log.length, 1)
  assert.equal(note.log[0].title, 'step')
})

test('reject_task sends the task back to active', () => {
  let note = run(emptyNote(), { type: 'add_task', title: 'oops' })
  const id = note.tasks[0].id
  note = run(note, { type: 'complete_task', id })
  note = run(note, { type: 'reject_task', id })
  assert.equal(note.tasks[0].state, 'active')
})

test('update_task refuses the done/awaiting shortcuts', () => {
  const note = run(emptyNote(), { type: 'add_task', title: 'x' })
  const id = note.tasks[0].id
  assert.throws(() => applyAction(note, { type: 'update_task', id, state: 'done' }), (err) => err.code === 'use-complete')
  const shelved = run(note, { type: 'update_task', id, state: 'shelved' })
  assert.equal(shelved.tasks[0].state, 'shelved')
  assert.equal(countsOf(shelved).shelved, 1)
})

test('remove_task and unknown ids fail loudly', () => {
  const note = run(emptyNote(), { type: 'add_task', title: 'x' })
  const id = note.tasks[0].id
  assert.equal(run(note, { type: 'remove_task', id }).tasks.length, 0)
  assert.throws(() => applyAction(note, { type: 'remove_task', id: 'nope' }), (err) => err.code === 'task-not-found')
  assert.throws(() => applyAction(note, { type: 'dance' }), (err) => err.code === 'unknown-action')
  assert.throws(() => applyAction(note, {}), (err) => err.code === 'bad-action')
})

test('set_focus writes both slots', () => {
  const note = run(run(emptyNote(), { type: 'set_focus', current: '写 client' }), { type: 'set_focus', next: '跑 test' })
  assert.equal(note.focus.current, '写 client')
  assert.equal(note.focus.next, '跑 test')
})

test('set_plan replaces the plan and keeps phase identity by title', () => {
  let note = run(emptyNote(), {
    type: 'set_plan',
    title: '插件开发',
    phases: [{ title: '调研', status: 'done' }, { title: '实现', status: 'active', weight: 2 }],
    goals: ['能拖', '能记忆'],
  })
  const firstPhaseId = note.plan.phases[0].id
  assert.equal(progressOf(note.plan).percent, 33)
  assert.equal(progressOf(note.plan).current, '实现')
  assert.equal(note.plan.goals.length, 2)

  note = run(note, {
    type: 'set_plan',
    phases: [{ title: '调研', status: 'done' }, { title: '实现', status: 'done' }, { title: '打磨', status: 'active', weight: 2 }],
  })
  assert.equal(note.plan.phases.length, 3)
  assert.equal(note.plan.phases[0].id, firstPhaseId)
  assert.equal(note.plan.title, '插件开发')
  // done weight 2 (调研 1 + 实现 1) / total 4 (打磨 weighs 2).
  assert.equal(progressOf(note.plan).percent, 50)
})

test('progress weights phases and survives an empty plan', () => {
  assert.deepEqual(progressOf(null), { percent: 0, done: 0, total: 0, current: '', goals: 0, goalsDone: 0 })
  const plan = { phases: [{ title: 'a', status: 'done', weight: 3 }, { title: 'b', status: 'todo', weight: 1 }] }
  assert.equal(progressOf(plan).percent, 75)
})

test('renderSnapshot stays inside the line budget and clips long text', () => {
  let note = run(emptyNote(), { type: 'set_focus', current: 'y'.repeat(200), next: '下一步' })
  for (let i = 0; i < 9; i += 1) note = run(note, { type: 'add_task', title: `任务${i}`.repeat(8) })
  note = run(note, { type: 'complete_task', id: note.tasks[0].id })
  note = run(note, { type: 'set_plan', phases: [{ title: 'p1', status: 'active' }], goals: ['g1'] })
  const snapshot = renderSnapshot(note)
  const lines = snapshot.split('\n')
  assert.ok(lines.length <= 6, `expected <= 6 lines, got ${lines.length}`)
  for (const line of lines) assert.ok(line.length <= 66, `line too long: ${line.length}`)
  assert.match(snapshot, /现在|进行中/)
})

test('renderSnapshot reports long-term progress', () => {
  let note = run(emptyNote(), { type: 'add_task', title: 'now' })
  note = run(note, {
    type: 'set_plan',
    title: 'B 阶段',
    phases: [{ title: '一', status: 'done' }, { title: '二', status: 'active' }, { title: '三' }],
    goals: ['目标 A', '目标 B'],
  })
  const snapshot = renderSnapshot(note)
  assert.match(snapshot, /阶段 1\/3/)
  assert.match(snapshot, /33%/)
  assert.match(snapshot, /二/)
  assert.match(snapshot, /目标 0\/2/)
})

test('readText exposes ids for follow-up tool calls', () => {
  const note = run(emptyNote(), { type: 'add_task', title: '写测试' })
  const text = readText(note, 'sess')
  assert.match(text, new RegExp(`\\[${note.tasks[0].id}\\]`))
  assert.match(text, /写测试/)
})

test('normalizeStore drops junk and pruneStore keeps the 80 newest', () => {
  const raw = {
    sessions: {
      a: { tasks: [{ title: 'ok' }, null, { title: '   ' }], plan: { phases: [{ title: 'p', status: 'bogus' }] } },
      b: 'not an object',
      '': { tasks: [] },
    },
  }
  const store = normalizeStore(raw)
  assert.deepEqual(Object.keys(store.sessions), ['a'])
  assert.equal(store.sessions.a.tasks.length, 1)
  assert.equal(store.sessions.a.plan.phases[0].status, 'todo')

  const crowded = { schemaVersion: 1, sessions: {} }
  for (let i = 0; i < LIMITS.sessions + 5; i += 1) crowded.sessions[`s${i}`] = { updatedAt: i }
  assert.equal(pruneStore(crowded), 5)
  assert.equal(Object.keys(crowded.sessions).length, LIMITS.sessions)
  assert.ok(crowded.sessions[`s${LIMITS.sessions + 4}`], 'newest session must survive')
})

test('a task can be parked under a plan phase by title or id', () => {
  const { note } = applyAction(emptyNote(), {
    type: 'set_plan',
    title: 'p',
    phases: [{ title: '调研', status: 'done' }, { title: '实现', status: 'active', weight: 2 }],
  })
  const phaseId = note.plan.phases[1].id
  const added = applyAction(note, { type: 'add_task', title: '搁置项', state: 'shelved', phase: '实现' }).note
  assert.equal(added.tasks[0].phaseId, phaseId, 'phase title resolves to its id')
  const byId = applyAction(added, { type: 'add_task', title: '另一条', phase: phaseId }).note
  assert.equal(byId.tasks[0].phaseId, phaseId)
  const moved = applyAction(byId, { type: 'update_task', id: byId.tasks[1].id, phase: '' }).note
  assert.equal(moved.tasks[1].phaseId, '')
})

test('rejecting a task keeps the rejection visible to the agent', () => {
  const base = applyAction(emptyNote(), { type: 'add_task', title: '重构时间线' }).note
  const id = base.tasks[0].id
  const waiting = applyAction(base, { type: 'complete_task', id }).note
  assert.equal(waiting.tasks[0].state, 'awaiting')

  const rejected = applyAction(waiting, { type: 'reject_task', id }).note
  assert.equal(rejected.tasks[0].state, 'active', 'a rejected task goes back to active')
  assert.equal(rejected.tasks[0].rejects, 1)
  assert.ok(rejected.tasks[0].rejectedAt > 0)

  const snapshot = renderSnapshot(rejected)
  assert.match(snapshot, /用户未通过/)
  assert.match(readText(rejected, 'sess'), /rejected by user ×1/)
})

test('move_task reorders the list, which is also the priority order', () => {
  let note = emptyNote()
  for (const title of ['a', 'b', 'c']) note = applyAction(note, { type: 'add_task', title }).note
  // add_task unshifts, so the list reads c, b, a
  assert.deepEqual(note.tasks.map((task) => task.title), ['c', 'b', 'a'])
  const idOf = (title) => note.tasks.find((task) => task.title === title).id

  const promoted = applyAction(note, { type: 'move_task', id: idOf('a'), beforeId: idOf('c') }).note
  assert.deepEqual(promoted.tasks.map((task) => task.title), ['a', 'c', 'b'])

  const demoted = applyAction(promoted, { type: 'move_task', id: idOf('c'), beforeId: null }).note
  assert.deepEqual(demoted.tasks.map((task) => task.title), ['a', 'b', 'c'])
  assert.ok(demoted.version > promoted.version, 'a move is a real change')

  assert.throws(() => applyAction(note, { type: 'move_task', id: 'nope' }), /no task with id/)
})


test('a fresh session is unlinked, and the first write links it for good', () => {
  const fresh = emptyNote()
  assert.equal(fresh.linkedAt, 0)
  assert.equal(isLinked(fresh), false, 'an untouched note is not linked')

  const linked = applyAction(fresh, { type: 'set_focus', current: 'ship the release' }).note
  assert.ok(linked.linkedAt > 0, 'writing focus marks the session linked')
  assert.equal(isLinked(linked), true)

  const cleared = applyAction(linked, { type: 'set_focus', current: '', next: '' }).note
  assert.equal(cleared.linkedAt, linked.linkedAt, 'linkedAt is sticky: we never re-nag')
  assert.equal(isLinked(cleared), true, 'an empty but once-linked note stays linked')
})

test('legacy notes with content count as linked even without linkedAt', () => {
  const legacy = emptyNote()
  legacy.focus.current = 'old note'
  assert.equal(isLinked(legacy), true)

  const withTasks = emptyNote()
  withTasks.tasks.push({ id: 't_1', title: 'x', state: 'active' })
  assert.equal(isLinked(withTasks), true)

  const withPlan = emptyNote()
  withPlan.plan.phases.push({ id: 'p_1', title: 'phase', status: 'todo', weight: 1 })
  assert.equal(isLinked(withPlan), true)
})

test('linkedAt survives normalization', () => {
  const note = applyAction(emptyNote(), { type: 'add_task', title: 'a' }).note
  const store = normalizeStore({ schemaVersion: 1, sessions: { s1: JSON.parse(JSON.stringify(note)) } })
  assert.equal(store.sessions.s1.linkedAt, note.linkedAt)
  assert.equal(isLinked(store.sessions.s1), true)
})


test('the live prompt block nags exactly once: only while unlinked', () => {
  const fresh = emptyNote()
  const nudged = renderLiveSection(fresh)
  assert.match(nudged, /还没有关联待办便签/, 'an unlinked session is told to link once')
  assert.match(nudged, /只做这一次/)

  const linked = applyAction(fresh, { type: 'set_focus', current: 'now' }).note
  assert.doesNotMatch(renderLiveSection(linked), /还没有关联待办便签/, 'a linked session is never nagged again')
  assert.match(renderLiveSection(linked), /现在：now/)

  assert.doesNotMatch(renderLiveSection(fresh, { nudge: false }), /还没有关联待办便签/)
})
