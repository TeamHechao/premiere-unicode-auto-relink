(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core'));
  else root.UnicodeLinkHost = factory(root.UnicodeLinkCore);
})(typeof globalThis === 'object' ? globalThis : this, function (Core) {
  'use strict';

  function identity(project) {
    var path = Core.native(project.path), guid = '';
    try { guid = project.guid && typeof project.guid.toString === 'function' ? project.guid.toString() : String(project.guid || ''); } catch (error) {}
    if (!path || !guid || guid === '[object Object]') throw new Error('请先保存工程；无法确认工程身份');
    return path + '|' + guid;
  }

  async function inventory(ppro, project) {
    var entries = [], warnings = [], seen = new Set();
    async function visit(folder) {
      var items = await folder.getItems();
      if (!Array.isArray(items)) throw new Error('素材箱列表无效');
      for (var item of items) {
        var id = '', child = null;
        try {
          id = await item.getId();
          if (typeof id !== 'string' || !id || id === 'undefined' || id === 'null') throw new Error('项目项身份无效');
          if (seen.has(id)) throw new Error('项目项身份重复');
          seen.add(id);
          try { child = await ppro.FolderItem.cast(item); } catch (castError) {}
          if (child) { await visit(child); continue; }
          var clip = await ppro.ClipProjectItem.cast(item);
          if (!clip) continue;
          var sequence = await clip.isSequence();
          if (sequence === true) continue;
          if (sequence !== false) throw new Error('序列状态未知');
          var raw = await clip.getMediaFilePath();
          if (typeof raw !== 'string') throw new Error('素材路径无效');
          if (!raw) continue;
          var offline = await clip.isOffline();
          if (typeof offline !== 'boolean') throw new Error('离线状态未知');
          entries.push({id: id, clip: clip, path: Core.native(raw), offline: offline});
        } catch (error) {
          warnings.push({id: id, name: String(item && item.name || ''), error: String(error.message || error)});
        }
      }
    }
    await visit(await project.getRootItem());
    return {entries: entries, warnings: warnings, complete: warnings.length === 0};
  }

  return {identity, inventory};
});
