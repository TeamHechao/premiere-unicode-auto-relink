(function () {
  'use strict';
  var fs = require('fs'), uxp = require('uxp'), ppro = require('premierepro');
  var Core = globalThis.UnicodeLinkCore, Host = globalThis.UnicodeLinkHost, Store = globalThis.UnicodeLinkStore;
  var config = null, store = null, visible = false, busy = false, generation = 0, timer = null, wired = false, loading = null;
  var unfinished = [];
  function el(id) { return document.getElementById(id); }
  function status(text) { el('status').textContent = text; }
  function render() {
    var hasRoots = !!(config && config.roots.length);
    el('choose').textContent = hasRoots ? '更换素材库' : '选择素材库并启用';
    el('toggle').hidden = !hasRoots;
    el('toggle').textContent = config && config.enabled ? '暂停自动检查' : '启用自动检查';
    el('open').disabled = !hasRoots;
    el('scan').disabled = !hasRoots;
    el('roots').textContent = hasRoots ? config.roots.map(function (root) { return root.path; }).join('\n') : '尚未选择素材库';
    el('data').textContent = store ? store.root : '';
    el('acknowledge').hidden = !unfinished.length;
  }
  function displayAliases() {
    el('aliases').value = config && config.roots.length ? config.roots[0].names.filter(function (name) {
      return name !== Core.base(config.roots[0].path);
    }).join('\n') : '';
  }
  async function pause(error) {
    if (config) config.enabled = false;
    generation++;
    status('自动检查已暂停');
    el('detail').textContent = String(error.message || error);
    if (store) {
      await store.record('error', {at: new Date().toISOString(), error: String(error.message || error)}).catch(function () {});
      if (config) await store.saveConfig(config).catch(function () {});
      try { unfinished = await store.pending(); } catch (readError) {}
    }
    render();
  }
  async function scan(force) {
    if (busy || !config || !visible || (!force && !config.enabled)) return;
    busy = true;
    var gen = generation, report = null;
    try {
      if ((await store.pending()).length) throw new Error('上次补链未完成，需核对记录和工程');
      if (!config.roots.length) throw new Error('尚未设置素材库');
      var project = await ppro.Project.getActiveProject();
      if (!project) { status('等待打开工程'); return; }
      var key = Host.identity(project), inventory = await Host.inventory(ppro, project);
      report = {project: Core.native(project.path), at: new Date().toISOString(), online: 0,
        linked: [], unresolved: [], skipped: [], warnings: inventory.warnings, backup: null, complete: false};
      if (!inventory.complete) throw new Error('素材清单读取不完整；已停止补链。' + inventory.warnings.map(function (item) {
        return item.error;
      }).slice(0, 3).join('；'));
      async function valid() {
        if (!visible || generation !== gen) return false;
        var active = await ppro.Project.getActiveProject();
        return !!active && Host.identity(active) === key;
      }
      for (var entry of inventory.entries) {
        if (!await valid()) throw new Error('工程或面板状态已改变');
        if (!entry.offline) { report.online++; continue; }
        if (!await Core.eligible(entry.clip)) { report.skipped.push({path: entry.path, reason: '特殊素材或不可修改'}); continue; }
        var match = await Core.resolve(fs, entry.path, config.roots);
        if (match.status !== 'match') {
          report.unresolved.push({path: entry.path, reason: match.status, candidates: match.candidates || []});
          continue;
        }
        if (!report.backup) report.backup = await store.backup(project);
        var transactionId = Store.stamp();
        var result = await Core.relink({fs: fs, clip: entry.clip, old: entry.path, target: match,
          roots: config.roots, validate: valid,
          journal: function (row) {
            return store.journal(transactionId, Object.assign({project: report.project, itemId: entry.id, backup: report.backup}, row));
          }});
        if (result.status === 'linked') report.linked.push({id: entry.id, old: entry.path, new: result.path});
        else report.skipped.push({path: entry.path, reason: result.status});
      }
      if (!await valid()) throw new Error('工程或面板状态已改变');
      report.complete = true;
      await store.record('last-scan', report);
      var pending = report.unresolved.length + report.skipped.length;
      status(report.linked.length ? '已补链 ' + report.linked.length + ' 条' : pending ? '有 ' + pending + ' 条需要核对' : '素材链接正常');
      el('detail').textContent = '正常 ' + report.online + ' · 本次补链 ' + report.linked.length + ' · 待核对 ' + pending +
        '\n' + report.unresolved.concat(report.skipped).slice(0, 6).map(function (item) {
          return Core.base(item.path) + '：' + item.reason;
        }).join('\n');
      return report;
    } catch (error) {
      if (report) { report.error = String(error.message || error); await store.record('last-scan', report).catch(function () {}); }
      await pause(error);
      throw error;
    } finally { busy = false; }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!visible) return;
    timer = setTimeout(async function () { try { await scan(false); } catch (error) {} schedule(); }, 7000);
  }
  async function openCompatible() {
    if (busy || !config) return;
    busy = true;
    var gen = generation, opened = false;
    try {
      var file = await uxp.storage.localFileSystem.getFileForOpening({types: ['prproj']});
      if (!file || !visible || gen !== generation) return;
      var options = new ppro.OpenProjectOptions();
      options.setShowLocateFileDialog(false);
      opened = !!await ppro.Project.open(file.nativePath, options);
      if (!opened) throw new Error('Premiere 未返回打开的工程');
    } finally { busy = false; }
    if (opened && visible && gen === generation) await scan(true);
  }
  async function saveRoots(path, enabled) {
    var names = el('aliases').value.split(/\r?\n/).map(function (name) { return name.trim(); }).filter(Boolean);
    var roots = Core.validateRoots([{path: path, names: [Core.base(path)].concat(names)}]);
    if (!await Core.plainDirectory(fs, roots[0].path)) throw new Error('素材库必须是可访问的普通文件夹');
    config = {schemaVersion: 1, enabled: !!enabled, roots: roots};
    generation++;
    await store.saveConfig(config);
    displayAliases(); render(); status('素材库已设置');
  }
  async function choose() {
    if (busy || !config) return;
    busy = true;
    var gen = generation;
    var firstRun = !config.roots.length, shouldScan = false;
    try {
      var folder = await uxp.storage.localFileSystem.getFolder();
      if (folder && visible && generation === gen) {
        await saveRoots(Core.native(folder.nativePath), firstRun ? true : config.enabled);
        shouldScan = !!config.enabled;
        status(firstRun ? '素材库已设置，正在检查…' : shouldScan ? '素材库已更新，正在检查…' : '素材库已更新');
      }
    } finally { busy = false; }
    if (shouldScan && visible) await scan(true);
    schedule();
  }
  function handle(fn) {
    return async function () {
      try { await fn(); }
      catch (error) { await pause(error); }
    };
  }
  async function initialize() {
    if (!wired) {
      wired = true;
      el('open').addEventListener('click', handle(openCompatible));
      el('choose').addEventListener('click', handle(choose));
      el('save-aliases').addEventListener('click', handle(async function () {
        if (busy || !config || !config.roots.length) return;
        busy = true;
        try { await saveRoots(config.roots[0].path, config.enabled); } finally { busy = false; }
      }));
      el('scan').addEventListener('click', handle(function () { return scan(true); }));
      el('toggle').addEventListener('click', handle(async function () {
        if (!config || busy || !config.roots.length) return;
        if (config.enabled) {
          config.enabled = false; generation++;
          await store.saveConfig(config); render(); status('自动检查已暂停');
          return;
        }
        busy = true;
        try {
          if ((await store.pending()).length || !config.roots.length) throw new Error('请先设置素材库并核对未完成记录');
          config.enabled = true; generation++;
          await store.saveConfig(config); render();
        } finally { busy = false; }
        await scan(false);
      }));
      el('acknowledge').addEventListener('click', handle(async function () {
        if (busy || !config) return;
        busy = true;
        try {
          for (var row of await store.pending()) await store.acknowledge(row.id);
          unfinished = []; render(); status('已记录核对，自动检查仍暂停');
        } finally { busy = false; }
      }));
    }
    if (!config) {
      var folder = await uxp.storage.localFileSystem.getDataFolder();
      store = Store.create(fs, folder.nativePath);
      config = await store.initialize();
      unfinished = await store.pending();
      if (unfinished.length) { config.enabled = false; await store.saveConfig(config); }
      displayAliases();
    }
    render();
    status(unfinished.length ? '需要核对上次补链' : !config.roots.length ? '先选择一次素材库' : config.enabled ? '自动检查已开启' : '自动检查已暂停');
    schedule();
  }
  uxp.entrypoints.setup({panels: {unicodeLink: {
    show: function () {
      visible = true; generation++;
      if (!loading) loading = handle(initialize)().finally(function () { loading = null; });
      return loading;
    },
    hide: function () { visible = false; generation++; if (timer) clearTimeout(timer); },
    destroy: function () { visible = false; generation++; if (timer) clearTimeout(timer); }
  }}});
})();
