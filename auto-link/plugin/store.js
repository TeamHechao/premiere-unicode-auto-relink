(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.UnicodeLinkStore = factory(root.UnicodeLinkCore);
})(typeof globalThis === 'object' ? globalThis : this, function (Core) {
  'use strict';

  function stamp() { return Date.now() + '-' + Math.random().toString(16).slice(2, 14); }
  function bytes(data) {
    return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  }
  function equalBytes(a, b) {
    a = bytes(a); b = bytes(b);
    return a.length === b.length && a.every(function (value, index) { return value === b[index]; });
  }
  function config(value) {
    if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') throw new Error('配置版本或格式不受支持');
    return {schemaVersion: 1, enabled: value.enabled, roots: Core.validateRoots(value.roots)};
  }

  function create(fs, root) {
    root = Core.native(root);
    async function directory(path) {
      try { await fs.lstat(path); } catch (error) { if (!Core.missing(error)) throw error; await fs.mkdir(path); }
      if (!await Core.plainDirectory(fs, path)) throw new Error('数据目录不是普通目录');
    }
    async function read(path) {
      var stat = await fs.lstat(path);
      if (!stat.isFile() || Core.isLink(stat)) throw new Error('记录不是普通文件');
      return JSON.parse(await fs.readFile(path, {encoding: 'utf-8'}));
    }
    async function write(path, value, exclusive) {
      if (!exclusive) {
        try {
          var stat = await fs.lstat(path);
          if (!stat.isFile() || Core.isLink(stat)) throw new Error('记录不是普通文件');
        } catch (error) { if (!Core.missing(error)) throw error; }
      }
      await fs.writeFile(path, JSON.stringify(value, null, 2), {encoding: 'utf-8', flag: exclusive ? 'wx' : 'w'});
      if (JSON.stringify(await read(path)) !== JSON.stringify(value)) throw new Error('记录读回失败');
    }
    async function initialize() {
      if (!await Core.plainDirectory(fs, root)) throw new Error('插件数据目录不可用');
      for (var name of ['backups', 'journals', 'runtime']) await directory(Core.join(root, name));
      var path = Core.join(root, 'config.json');
      try { return config(await read(path)); }
      catch (error) {
        if (!Core.missing(error)) throw error;
        var defaults = {schemaVersion: 1, enabled: false, roots: []};
        await write(path, defaults, true);
        return defaults;
      }
    }
    async function backup(project) {
      var path = Core.native(project.path), before = await Core.statFile(fs, path);
      if (!/\.prproj$/i.test(path) || !before) throw new Error('请先保存工程，才能建立补链前备份');
      var data = await fs.readFile(path), destination = Core.join(root, 'backups/' + stamp() + '.prproj');
      await fs.writeFile(destination, data, {flag: 'wx'});
      var after = await Core.statFile(fs, path);
      if (!equalBytes(data, await fs.readFile(destination)) || !after ||
          !Core.sameStat(Core.snapshot(before), Core.snapshot(after)) || !equalBytes(data, await fs.readFile(path))) {
        throw new Error('工程备份校验失败或原工程在备份时改变');
      }
      return {original: path, backup: destination, bytes: bytes(data).length, saved_file_only: true};
    }
    async function pending() {
      var names = await fs.readdir(Core.join(root, 'journals')), result = [];
      for (var name of names) {
        if (!name.endsWith('-prepared.json')) continue;
        var id = name.slice(0, -'-prepared.json'.length);
        var prepared = await read(Core.join(root, 'journals/' + name)), complete = false;
        if (prepared.stage !== 'prepared') throw new Error('准备日志格式损坏');
        for (var stage of ['verified', 'cancelled', 'acknowledged']) {
          var terminal = id + '-' + stage + '.json';
          if (names.indexOf(terminal) < 0) continue;
          var record = await read(Core.join(root, 'journals/' + terminal));
          if (record.stage !== stage) throw new Error('结束日志格式损坏');
          complete = true;
        }
        if (!complete) result.push({id: id, record: prepared});
      }
      return result;
    }
    return {
      root: root,
      initialize: initialize,
      backup: backup,
      pending: pending,
      saveConfig: function (value) { return write(Core.join(root, 'config.json'), config(value), false); },
      journal: function (id, row) { return write(Core.join(root, 'journals/' + id + '-' + row.stage + '.json'), row, true); },
      record: function (name, value) { return write(Core.join(root, 'runtime/' + name + '.json'), value, false); },
      acknowledge: function (id) { return write(Core.join(root, 'journals/' + id + '-acknowledged.json'), {at: new Date().toISOString(), stage: 'acknowledged'}, true); }
    };
  }

  return {create, stamp, bytes, equalBytes, config};
});
