const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../extension/background.js'), 'utf8');
const queue = source.slice(source.indexOf('async function acquireCommandKeys('), source.indexOf('\nfunction connect()'));
const handler = source.slice(source.indexOf('const TARGET_COMMANDS ='), source.indexOf('\nasync function execute('));
let finishHelp;
const context = {
  commandTails: new Map(),
  ensureRegistryLoaded: async () => {},
  requireManaged: () => ({ session: 'same-session' }),
  execute: (command) => command === 'requestHelp'
    ? new Promise((resolve) => { finishHelp = resolve; })
    : Promise.resolve(command),
};
vm.createContext(context);
vm.runInContext(`${queue}\n${handler}`, context);

(async () => {
  const help = context.handle('requestHelp', { target: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishHelp, 'function');
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error('other command blocked by help')), 100));
  assert.equal(await Promise.race([context.handle('info', { target: '2' }), deadline]), 'info');
  assert.equal(await Promise.race([context.handle('close', { target: '1' }), deadline]), 'close');
  finishHelp('continued');
  assert.equal(await help, 'continued');
})().catch((error) => { console.error(error); process.exitCode = 1; });
