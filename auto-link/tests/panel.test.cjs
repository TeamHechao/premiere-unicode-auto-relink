const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm');
const Core = require('../plugin/core.js'), Host = require('../plugin/host.js'), Store = require('../plugin/store.js');

async function fixture(t) {
  const work = path.join(__dirname, '../work');
  await fs.mkdir(work, {recursive: true});
  const root = await fs.mkdtemp(path.join(work, 'panel-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const data = path.join(root, 'data'), library = path.join(root, 'PostPackage');
  await fs.mkdir(data); await fs.mkdir(library);
  await fs.writeFile(path.join(library, 'ピ.wav'), 'synthetic audio');
  const projectPath = path.join(root, 'test.prproj');
  await fs.writeFile(projectPath, 'synthetic saved project');
  const clip = {
    mediaPath: '/Volumes/Test/PostPackage/ピ.wav'.normalize('NFD'), offline: true, calls: [],
    async isSequence() { return false; }, async isMergedClip() { return false; }, async isMulticamClip() { return false; },
    async canChangeMediaPath() { return true; }, async hasProxy() { return false; },
    async getMediaFilePath() { return this.mediaPath; }, async isOffline() { return this.offline; },
    async changeMediaFilePath(newPath, override) { this.calls.push({newPath, override}); this.mediaPath = newPath; this.offline = false; return true; },
    async refreshMedia() { return true; }
  };
  const items = [{kind: 'clip', name: 'BGM', async getId() { return 'clip-1'; }, clip}];
  const project = {path: projectPath, guid: {toString() { return 'guid-test'; }},
    async getRootItem() { return {async getItems() { return items; }}; },
    async save() { throw new Error('The panel must not automatically save'); }};
  return {root, data, library, project, items, clip};
}

async function load(f, hooks = {}) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {textContent: '', value: '', hidden: false,
      addEventListener(event, handler) { this[event] = handler; }});
    return nodes.get(id);
  }
  let panel;
  const uxp = {storage: {localFileSystem: {
    async getDataFolder() { return {nativePath: f.data}; },
    async getFolder() { return {nativePath: f.library}; },
    async getFileForOpening() { return null; }
  }}, entrypoints: {setup(value) { panel = value.panels.unicodeLink; }}};
  const ppro = {
    Project: {async getActiveProject() { return hooks.activeProject ? hooks.activeProject() : f.project; }},
    FolderItem: {async cast() { throw new Error('not a folder'); }},
    ClipProjectItem: {async cast(item) { if (!item.clip) throw new Error('unknown item'); return item.clip; }}
  };
  const appFs = Object.assign({}, fs, {async writeFile(file, data, options) {
    await fs.writeFile(file, data, options);
    if (hooks.wrote) await hooks.wrote(file, data, panel);
  }});
  const context = vm.createContext({UnicodeLinkCore: Core, UnicodeLinkHost: Host, UnicodeLinkStore: Store,
    require(name) { return {fs: appFs, uxp, premierepro: ppro}[name]; },
    document: {getElementById: node}, setTimeout() { return 1; }, clearTimeout() {}});
  vm.runInContext(await fs.readFile(path.join(__dirname, '../plugin/main.js'), 'utf8'), context);
  await panel.show();
  return {node, panel};
}

test('first run is disabled; manual scan backs up, journals and does not save the project', async t => {
  const f = await fixture(t), ui = await load(f);
  assert.equal(f.clip.calls.length, 0);
  await ui.node('choose').click();
  assert.equal(f.clip.calls.length, 0);
  await ui.node('scan').click();
  assert.equal(f.clip.calls.length, 1);
  assert.equal(f.clip.calls[0].override, false);
  assert.equal((await fs.readdir(path.join(f.data, 'backups'))).length, 1);
  assert.equal((await Store.create(fs, f.data).pending()).length, 0);
  assert.match(ui.node('status').textContent, /已补链 1/);
  assert.equal(await fs.readFile(f.project.path, 'utf8'), 'synthetic saved project');
});

test('incomplete inventory causes no backup or host mutation', async t => {
  const f = await fixture(t);
  f.items.push({name: 'unknown', async getId() { return 'clip-2'; }});
  const ui = await load(f);
  await ui.node('choose').click(); await ui.node('scan').click();
  assert.equal(f.clip.calls.length, 0);
  assert.equal((await fs.readdir(path.join(f.data, 'backups'))).length, 0);
  assert.match(ui.node('detail').textContent, /清单读取不完整/);
});

test('project switch or hiding the panel during logging blocks the host call', async t => {
  for (const mode of ['switch', 'hide']) {
    const f = await fixture(t);
    let switched = false;
    const ui = await load(f, {
      activeProject: () => switched ? {path: f.project.path, guid: {toString: () => 'different-guid'}} : f.project,
      async wrote(file, data, panel) {
        if (!file.endsWith('-prepared.json')) return;
        if (mode === 'switch') switched = true; else panel.hide();
      }
    });
    await ui.node('choose').click(); await ui.node('scan').click();
    assert.equal(f.clip.calls.length, 0);
    assert.equal((await Store.create(fs, f.data).pending()).length, 1);
    assert.match(ui.node('status').textContent, /暂停/);
  }
});

test('an unfinished transaction survives restart and needs explicit review', async t => {
  const f = await fixture(t), store = Store.create(fs, f.data);
  await store.initialize();
  await store.saveConfig({schemaVersion: 1, enabled: true, roots: [{path: f.library, names: ['PostPackage']}]});
  await store.journal('previous', {stage: 'prepared', old: f.clip.mediaPath});
  const ui = await load(f);
  assert.equal(ui.node('acknowledge').hidden, false);
  assert.equal((await store.initialize()).enabled, false);
  await ui.node('scan').click();
  assert.equal(f.clip.calls.length, 0);
  await ui.node('acknowledge').click();
  assert.equal((await store.pending()).length, 0);
  assert.equal(f.clip.calls.length, 0);
  await ui.node('scan').click();
  assert.equal(f.clip.calls.length, 1);
});
