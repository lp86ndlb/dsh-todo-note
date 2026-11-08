import assert from 'node:assert/strict'
import test from 'node:test'

// The client half is hand-wrapped in the DSH ModuleLoader envelope, so the only
// way to load it in Node is to stub that envelope and React. Everything the
// tests touch below is pure (no hooks, no DOM), so a bare stub is enough - and
// importing the file at all proves it loads without throwing.
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      captured = { id, exports: factory((name) => (name === 'react' ? React : undefined)) }
    },
  },
}

await import('../lib/client.js')

const { exports } = captured
const { resolveDrop, moveToIndex, moveBefore, mergedRows } = exports.internals

test('the client module loads through the ModuleLoader envelope', () => {
  assert.equal(captured.id, 'dsh-todo-note')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.internals.readPrefs, 'function')
})

test('resolveDrop picks the slot the pointer center has passed', () => {
  const mids = [100, 200, 300]
  assert.equal(resolveDrop(mids, 0), 0)
  assert.equal(resolveDrop(mids, 99), 0)
  // Landing exactly on a midpoint means the row has been passed, not that the
  // slot sits above it: the comparison is strict.
  assert.equal(resolveDrop(mids, 100), 1)
  assert.equal(resolveDrop(mids, 250), 2)
  assert.equal(resolveDrop(mids, 999), 3)
  assert.equal(resolveDrop([], 42), 0)
})

test('resolveDrop is monotonic: a lower center never yields a lower slot', () => {
  const mids = [40, 80, 120, 160]
  let previous = 0
  for (let center = 0; center <= 200; center += 5) {
    const slot = resolveDrop(mids, center)
    assert.ok(slot >= previous, `slot went backwards at ${center}`)
    previous = slot
  }
  assert.equal(previous, mids.length)
})

test('moveToIndex moves one row and clamps the target', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(
    moveToIndex(list, 'c', 0).map((task) => task.id),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(
    moveToIndex(list, 'a', 99).map((task) => task.id),
    ['b', 'c', 'a'],
  )
  assert.deepEqual(
    moveToIndex(list, 'a', 1).map((task) => task.id),
    ['b', 'a', 'c'],
  )
  assert.deepEqual(list.map((task) => task.id), ['a', 'b', 'c'], 'input must not mutate')
  assert.equal(moveToIndex(list, 'missing', 0), list)
})

test('moveBefore agrees with the slot the drop reported', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  // Dropped above `b`, so `c` lands right before it.
  assert.deepEqual(
    moveBefore(list, 'c', 'b').map((task) => task.id),
    ['a', 'c', 'b'],
  )
  // Dropped past the last row: append.
  assert.deepEqual(
    moveBefore(list, 'a', null).map((task) => task.id),
    ['b', 'c', 'a'],
  )
  // A stale beforeId (row struck out mid-drag) must not lose the task.
  assert.equal(moveBefore(list, 'a', 'gone'), list)
})

test('mergedRows splices struck rows back in at their old index', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }]
  const rows = mergedRows(tasks, [{ task: { id: 'x' }, index: 1, height: 30 }])
  assert.deepEqual(
    rows.map((row) => row.task.id + (row.ghost ? '!' : '')),
    ['a', 'x!', 'b'],
  )
  assert.equal(rows[1].height, 30)
})
