import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function bridge(failClose = false) {
  const live = new Map([[1, { id: 1, windowId: 99 }], [2, { id: 2, windowId: 10 }], [3, { id: 3, windowId: 10 }]]);
  const removed = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    console, setTimeout: () => 0, navigator: { userAgent: 'test' },
    WebSocket: class { static OPEN = 1; },
    chrome: {
      alarms: { create() {}, onAlarm: event },
      storage: { session: { set: async () => {} } },
      tabs: { onRemoved: event, get: async (id) => { if (!live.has(id)) throw new Error('missing tab'); return live.get(id); }, remove: async (id) => { if (failClose) throw new Error('cannot close'); removed.push(id); live.delete(id); } },
      windows: { onRemoved: event, remove: async () => { throw new Error('must not close the window'); } },
      tabGroups: { onRemoved: event }, debugger: { onDetach: event, onEvent: event },
    },
  });
  vm.runInContext(readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8') + `
    registryLoaded = true;
    managedTabs.set(1, {session:'test',ownership:'created'});
    managedTabs.set(2, {session:'test',ownership:'borrowed'});
    managedTabs.set(4, {session:'test',ownership:'created'});
    agentWindows.set('test',10);
    globalThis.runClose = () => handle('closeSession',{session:'test'});
    globalThis.isManaged = (id) => managedTabs.has(id);
  `, context);
  return { context, live, removed };
}

test('session 收尾关闭移走的 created 页，归还 borrowed 页，保留用户页且核实数量', async () => {
  const f = bridge();
  const result = await f.context.runClose();
  assert.equal(result.closed, 1); assert.equal(result.returned, 1);
  assert.deepEqual(f.removed, [1]);
  assert.ok(f.live.has(2)); assert.ok(f.live.has(3));
  assert.equal(f.context.isManaged(2), false); assert.equal(f.context.isManaged(4), false);
});

test('session 收尾关闭失败会返回错误并保留追踪，可重试', async () => {
  const f = bridge(true);
  await assert.rejects(f.context.runClose(), /cannot close/);
  assert.equal(f.context.isManaged(1), true); assert.ok(f.live.has(1));
});
