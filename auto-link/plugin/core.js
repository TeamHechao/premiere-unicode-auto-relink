(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UnicodeLinkCore = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function native(value) {
    value = String(value || '');
    if (/^file:/i.test(value)) {
      var uri = value.slice(5);
      if (/^\/\/localhost\//i.test(uri)) uri = uri.slice(11);
      else if (uri.startsWith('///')) uri = uri.slice(2);
      value = decodeURIComponent(uri);
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1);
    }
    return value.replace(/\\/g, '/');
  }

  function canon(value) { return String(value).normalize('NFC'); }
  function join(parent, name) { return native(parent).replace(/\/$/, '') + '/' + name; }
  function base(value) { return native(value).replace(/\/$/, '').split('/').pop(); }
  function absolute(value) { return /^[A-Za-z]:\//.test(value) || value.startsWith('/'); }

  function sameExact(a, b) {
    function key(value) {
      value = native(value);
      return value.replace(/^[a-z]:/, function (drive) { return drive.toUpperCase(); });
    }
    return key(a) === key(b);
  }

  function parts(value) {
    var result = native(value).split('/');
    if (/^\/\/[?.]\//.test(native(value)) || result.some(function (item) { return item === '.' || item === '..' || /[\x00-\x1f]/.test(item); })) {
      throw new Error('路径含不允许的目录组件');
    }
    return result;
  }

  function missing(error) {
    var code = String(error && (error.code || error.errno) || '').toUpperCase();
    var message = String(error && error.message || error || '');
    if (/EACCES|EPERM|EBUSY|EIO|ENOSPC|DENIED|SHARING|LOCK VIOLATION/i.test(code + ' ' + message)) return false;
    if (['ENOENT', 'ENOTDIR', 'FILE_NOT_FOUND', 'PATH_NOT_FOUND', 'NOTFOUNDERROR', '2', '3', '-2', '-4058'].indexOf(code) >= 0) return true;
    return /\bENOENT\b|no such file or directory|(?:file|path) (?:does not exist|not found)|系统找不到指定的(?:文件|路径)/i.test(message);
  }

  function isLink(st) {
    if (typeof st.isSymbolicLink === 'function') return st.isSymbolicLink();
    if (typeof st.isSymbolicLink === 'boolean') return st.isSymbolicLink;
    if (Number.isFinite(st.mode)) return (st.mode & 0xf000) === 0xa000;
    throw new Error('文件系统未提供链接类型信息');
  }

  function snapshot(st) {
    var size = Number(st.size), mtime = Number(st.mtimeMs || +st.mtime);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime)) throw new Error('文件信息不完整');
    return {size: size, mtime: mtime, ctime: Number(st.ctimeMs || +st.ctime || 0),
      ino: String(st.ino || ''), dev: String(st.dev || '')};
  }

  function sameStat(a, b) {
    return ['size', 'mtime', 'ctime', 'ino', 'dev'].every(function (key) { return a[key] === b[key]; });
  }

  async function statFile(fs, path) {
    try {
      var st = await fs.lstat(path);
      return st.isFile() && !isLink(st) && st.size > 0 ? st : null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function plainDirectory(fs, path) {
    path = native(path);
    if (path !== '/' && !/^[A-Za-z]:\/$/.test(path)) path = path.replace(/\/$/, '');
    parts(path);
    var prefix, rest;
    if (/^[A-Za-z]:\//.test(path)) { prefix = path.slice(0, 3); rest = path.slice(3); }
    else if (path.startsWith('//')) {
      var unc = /^\/\/[^/]+\/[^/]+/.exec(path);
      if (!unc) throw new Error('无效的网络目录');
      prefix = unc[0]; rest = path.slice(prefix.length).replace(/^\//, '');
    } else if (path.startsWith('/')) { prefix = '/'; rest = path.slice(1); }
    else throw new Error('目录不是绝对路径');
    var paths = [prefix];
    for (var name of rest.split('/').filter(Boolean)) { prefix = join(prefix, name); paths.push(prefix); }
    for (var current of paths) {
      var st;
      try { st = await fs.lstat(current); } catch (error) { if (missing(error)) return false; throw error; }
      if (!st.isDirectory() || isLink(st)) return false;
    }
    return true;
  }

  function validateRoots(roots) {
    if (!Array.isArray(roots)) throw new Error('素材库配置必须是数组');
    return roots.map(function (library) {
      if (!library || typeof library.path !== 'string') throw new Error('素材库路径无效');
      var path = native(library.path).replace(/\/$/, '');
      if (!absolute(path) || !base(path) || /^[A-Za-z]:$/.test(path)) throw new Error('请选择素材库文件夹');
      parts(path);
      var names = library.names === undefined ? [base(path)] : library.names;
      if (!Array.isArray(names) || !names.length || names.some(function (name) {
        return typeof name !== 'string' || !name || /[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..';
      })) throw new Error('旧目录名必须是单个目录名称');
      return {path: path, names: Array.from(new Set(names.concat(base(path))))};
    });
  }

  async function resolve(fs, old, roots) {
    old = native(old);
    if (!absolute(old) || !/\.(mp3|wav|m4a|aac|aif|aiff|flac|ogg)$/i.test(old)) return {status: 'unsupported'};
    var components = parts(old), candidates = new Map(), scoped = false;
    for (var library of validateRoots(roots)) {
      var indices = [];
      components.forEach(function (name, index) {
        if (library.names.some(function (anchor) { return canon(anchor) === canon(name); })) indices.push(index);
      });
      if (indices.length > 1) return {status: 'ambiguous', reason: '路径中重复出现库名称'};
      if (!indices.length) continue;
      scoped = true;
      var rest = components.slice(indices[0] + 1);
      if (!rest.length || rest.some(function (item) { return !item; })) continue;
      if (!await plainDirectory(fs, library.path)) continue;
      var current = [library.path];
      for (var i = 0; i < rest.length; i++) {
        var next = [];
        for (var parent of current) {
          var names = await fs.readdir(parent);
          for (var name of names) {
            if (typeof name !== 'string') throw new Error('目录列表不是名称文本');
            if (canon(name) !== canon(rest[i])) continue;
            var found = join(parent, name), st;
            try { st = await fs.lstat(found); } catch (error) { if (missing(error)) continue; throw error; }
            if (isLink(st)) continue;
            if (i === rest.length - 1 ? st.isFile() && st.size > 0 : st.isDirectory()) next.push(found);
          }
        }
        current = next;
        if (!current.length) break;
      }
      for (var candidate of current) {
        var file = await statFile(fs, candidate);
        if (file) candidates.set(candidate, {path: candidate, stat: snapshot(file)});
      }
    }
    var values = Array.from(candidates.values());
    if (values.length > 1) return {status: 'ambiguous', candidates: values.map(function (item) { return item.path; })};
    if (!values.length) return {status: scoped ? 'missing' : 'out_of_scope'};
    return Object.assign({status: 'match'}, values[0]);
  }

  async function eligible(clip) {
    return await clip.canChangeMediaPath() === true && await clip.hasProxy() === false &&
      await clip.isMergedClip() === false && await clip.isMulticamClip() === false && await clip.isSequence() === false;
  }

  async function relink(options) {
    var clip = options.clip, old = options.old, target = options.target, fs = options.fs;
    var roots = options.roots, validate = options.validate, journal = options.journal;
    var delay = options.delay || function (ms) { return new Promise(function (resolveDelay) { setTimeout(resolveDelay, ms); }); };
    async function guard() { if (!await validate()) throw new Error('工程已切换或自动检查已停止'); }
    async function checkClip() {
      if (!sameExact(await clip.getMediaFilePath(), old)) throw new Error('素材引用在检查期间已改变');
      if (await clip.isOffline() !== true) return 'became_online';
      return await eligible(clip) ? null : 'unsupported';
    }
    async function checkTarget() {
      var current = await resolve(fs, old, roots);
      if (current.status !== 'match' || !sameExact(current.path, target.path) || !sameStat(current.stat, target.stat)) {
        throw new Error('候选文件在检查期间已改变或不再唯一');
      }
    }
    if (!target || target.status !== 'match') throw new Error('未提供唯一候选文件');
    await guard();
    var skipped = await checkClip();
    if (skipped) return {status: skipped};
    await checkTarget();
    var row = {old: old, new: target.path, stage: 'prepared', at: new Date().toISOString()};
    await journal(row);
    try {
      // The host call is non-undoable, so repeat every check after asynchronous logging.
      await checkTarget();
      skipped = await checkClip();
      if (skipped) { row.stage = 'cancelled'; await journal(row); return {status: skipped}; }
      await guard();
      if (await clip.changeMediaFilePath(target.path, false) !== true) throw new Error('Premiere 拒绝重链接');
      row.stage = 'path_changed'; await journal(row);
      if (await clip.refreshMedia() !== true) throw new Error('Premiere 刷新媒体失败');
      var verified = false;
      for (var i = 0; i < 10; i++) {
        await guard();
        if (sameExact(await clip.getMediaFilePath(), target.path) && await clip.isOffline() === false) { verified = true; break; }
        await delay(150);
      }
      if (!verified) throw new Error('重链接后读回失败');
      row.stage = 'verified'; await journal(row);
      return {status: 'linked', path: target.path};
    } catch (error) {
      row.stage = 'failed'; row.error = String(error.message || error);
      try { await journal(row); } catch (loggingError) {}
      throw error;
    }
  }

  return {native, canon, join, base, sameExact, missing, isLink, snapshot, sameStat,
    statFile, plainDirectory, validateRoots, resolve, eligible, relink};
});
