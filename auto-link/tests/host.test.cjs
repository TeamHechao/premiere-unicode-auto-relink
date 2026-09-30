const test = require('node:test');
const assert = require('node:assert/strict');
const Host = require('../plugin/host.js');

function fakePpro() {
  return {
    FolderItem: {cast: async item => {
      if (item.kind !== 'folder') throw new Error('not a folder');
      return item;
    }},
    ClipProjectItem: {cast: async item => {
      if (item.kind !== 'clip') throw new Error('not a clip');
      return item.clip;
    }}
  };
}

test('project identity uses a saved path and Guid.toString()', () => {
  const value = Host.identity({path: 'C:\\Edit\\show.prproj', guid: {toString: () => 'guid-1'}});
  assert.equal(value, 'C:/Edit/show.prproj|guid-1');
  assert.throws(() => Host.identity({path: '', guid: {toString: () => 'guid-1'}}), /保存工程/);
});

test('inventory stops automatic relink when a project item cannot be read', async () => {
  const clip = {async isSequence() { return false; }, async getMediaFilePath() { return 'C:/BGM/ok.mp3'; }, async isOffline() { return true; }};
  const root = {
    kind: 'folder',
    async getItems() {
      return [
        {kind: 'clip', name: 'ok', async getId() { return '1'; }, clip},
        {kind: 'clip', name: 'broken', async getId() { return '2'; }, clip: {async isSequence() { throw new Error('host read failed'); }}},
        {kind: 'folder', name: 'bin', async getId() { return '3'; }, async getItems() { return []; }}
      ];
    }
  };
  const project = {async getRootItem() { return root; }};
  const result = await Host.inventory(fakePpro(), project);
  assert.equal(result.entries.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.warnings[0].error, /host read failed/);
});

test('duplicate project item IDs are warnings and never duplicated in the inventory', async () => {
  const clip = {async isSequence() { return false; }, async getMediaFilePath() { return 'C:/BGM/ok.mp3'; }, async isOffline() { return false; }};
  const root = {kind: 'folder', async getItems() {
    return [
      {kind: 'clip', name: 'one', async getId() { return 'same'; }, clip},
      {kind: 'clip', name: 'two', async getId() { return 'same'; }, clip}
    ];
  }};
  const result = await Host.inventory(fakePpro(), {async getRootItem() { return root; }});
  assert.equal(result.entries.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.warnings[0].error, /重复/);
});
