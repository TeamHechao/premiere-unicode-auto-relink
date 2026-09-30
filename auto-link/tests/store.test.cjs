const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Store = require('../plugin/store.js');

async function fixture(t) {
  await fs.mkdir(path.join(__dirname, '../work'), {recursive: true});
  const root = await fs.mkdtemp(path.join(__dirname, '../work/store-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('store initializes isolated data folders and keeps config portable', async t => {
  const root = await fixture(t), store = Store.create(fs, root);
  const config = await store.initialize();
  assert.deepEqual(config, {schemaVersion: 1, enabled: false, roots: []});
  const media = path.join(root, 'media');
  await fs.mkdir(media);
  await store.saveConfig({schemaVersion: 1, enabled: true, roots: [{path: media, names: ['后期包']}]});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')).roots[0].path, media.replace(/\\/g, '/'));
});

test('store journals are exclusive and unfinished work blocks repeat scans', async t => {
  const root = await fixture(t), store = Store.create(fs, root);
  await store.initialize();
  const id = 'transaction-test';
  await store.journal(id, {stage: 'prepared', old: '/Volumes/X/后期包/ピ.wav'});
  assert.equal((await store.pending()).length, 1);
  await store.journal(id, {stage: 'verified'});
  assert.equal((await store.pending()).length, 0);
  await assert.rejects(store.journal(id, {stage: 'prepared'}));
});

test('backup copies bytes and refuses a changed project', async t => {
  const root = await fixture(t), store = Store.create(fs, root);
  await store.initialize();
  const projectPath = path.join(root, 'episode.prproj');
  await fs.writeFile(projectPath, Buffer.from('project bytes'));
  const backup = await store.backup({path: projectPath});
  assert.equal(await fs.readFile(backup.backup, 'utf8'), 'project bytes');
  let sourceReads = 0;
  const projectKey = projectPath.replace(/\\/g, '/');
  const racingFs = Object.assign({}, fs, {
    readFile: async (file, options) => {
      const result = await fs.readFile(file, options);
      if (String(file) === projectKey) {
        sourceReads += 1;
        return sourceReads === 1 ? result : Buffer.from('changed');
      }
      return result;
    }
  });
  await assert.rejects(Store.create(racingFs, root).backup({path: projectPath}), /备份校验|改变/);
  assert.ok(sourceReads >= 2);
});

test('malformed config and terminal logs cannot enable automatic work', async t => {
  const root = await fixture(t), store = Store.create(fs, root);
  await store.initialize();
  await store.journal('broken', {stage: 'prepared', old: 'old.wav'});
  await fs.writeFile(path.join(root, 'journals/broken-verified.json'), '{');
  await assert.rejects(store.pending(), SyntaxError);
  await fs.writeFile(path.join(root, 'config.json'), '{');
  await assert.rejects(store.initialize(), SyntaxError);
  assert.equal(await fs.readFile(path.join(root, 'config.json'), 'utf8'), '{');
});

test('cancelled and user-reviewed transactions retain logs without retrying', async t => {
  const root = await fixture(t), store = Store.create(fs, root);
  await store.initialize();
  await store.journal('cancel', {stage: 'prepared'});
  await store.journal('cancel', {stage: 'cancelled'});
  await store.journal('failed', {stage: 'prepared'});
  await store.journal('failed', {stage: 'failed'});
  assert.deepEqual((await store.pending()).map(row => row.id), ['failed']);
  await store.acknowledge('failed');
  assert.equal((await store.pending()).length, 0);
  assert.equal((await fs.readdir(path.join(root, 'journals'))).length, 5);
});
