import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpError,
  KeyedQueue,
  ManagedTargetRegistry,
  elementResolverSource,
  requestQueueKeys,
} from '../scripts/runtime-core.mjs';
import { semanticSnapshotExpression } from '../scripts/semantic-snapshot.mjs';

test('managed registry distinguishes created and borrowed targets', () => {
  let now = 100;
  const registry = new ManagedTargetRegistry(() => now++);
  assert.equal(registry.registerCreated('created-1', 'alpha').ownership, 'created');
  assert.equal(registry.borrow('user-1', 'alpha').ownership, 'borrowed');
  assert.equal(registry.require('user-1', 'alpha').session, 'alpha');
  assert.throws(() => registry.require('unknown'), (error) => error instanceof HttpError && error.statusCode === 409);
  assert.throws(() => registry.borrow('user-1', 'beta'), /已由 session alpha 托管/);
  assert.deepEqual(registry.forSession('alpha').map((entry) => entry.targetId).sort(), ['created-1', 'user-1']);
  assert.equal(registry.release('user-1').ownership, 'borrowed');
  assert.equal(registry.has('user-1'), false);
});

test('keyed queue serializes one target while allowing unrelated targets to proceed', async () => {
  const queue = new KeyedQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run('target:a', async () => {
    events.push('a1-start');
    await firstGate;
    events.push('a1-end');
  });
  const second = queue.run('target:a', async () => events.push('a2'));
  const parallel = queue.run('target:b', async () => events.push('b1'));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1-start', 'b1']);
  releaseFirst();
  await Promise.all([first, second, parallel]);
  assert.deepEqual(events, ['a1-start', 'b1', 'a1-end', 'a2']);
  assert.equal(queue.size, 0);
});

test('request queue uses target first and session for lifecycle operations', () => {
  assert.deepEqual(requestQueueKeys('/click', { target: '1' }, 's'), ['target:1', 'session:s']);
  assert.deepEqual(requestQueueKeys('/close', { session: 's' }), ['session:s']);
  assert.deepEqual(requestQueueKeys('/new', {}), ['session:default']);
  assert.deepEqual(requestQueueKeys('/health', {}), []);
  assert.deepEqual(requestQueueKeys('/borrow', { target: '1' }), ['target:1', 'session:default']);
});

test('multi-key lock prevents target operations racing their session close', async () => {
  const queue = new KeyedQueue();
  const releaseTarget = await queue.acquireMany(['target:1', 'session:s']);
  let sessionEntered = false;
  const sessionClose = queue.run('session:s', async () => { sessionEntered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessionEntered, false);
  releaseTarget();
  await sessionClose;
  assert.equal(sessionEntered, true);
});

test('semantic snapshot keeps the same @eN ref for the same element', () => {
  const element = {
    tagName: 'BUTTON',
    disabled: false,
    labels: [],
    textContent: '提交',
    href: '',
    type: 'submit',
    shadowRoot: null,
    getAttribute(name) { return name === 'aria-label' ? '提交订单' : null; },
    matches() { return true; },
    getBoundingClientRect() { return { x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 }; },
  };
  const document = {
    title: 'Checkout',
    querySelectorAll() { return [element]; },
    querySelector() { return element; },
    getElementById() { return null; },
  };
  const window = {};
  const run = new Function(
    'window', 'document', 'location', 'innerHeight', 'innerWidth', 'getComputedStyle',
    `return ${semanticSnapshotExpression()};`,
  );
  const args = [window, document, { href: 'https://example.com' }, 800, 1200, () => ({ display: 'block', visibility: 'visible', opacity: '1' })];
  const first = run(...args);
  const second = run(...args);
  assert.equal(first.items[0].ref, '@e1');
  assert.equal(second.items[0].ref, '@e1');
  assert.equal(first.items[0].role, 'button');
  assert.equal(first.items[0].name, '提交订单');

  const resolve = new Function('window', 'document', `return ${elementResolverSource('@e1')};`);
  assert.equal(resolve(window, document), element);
});
