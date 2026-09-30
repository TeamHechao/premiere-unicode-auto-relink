const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const Core=require('../plugin/core.js');
async function fixture(t){await fs.mkdir(path.join(__dirname,'../work'),{recursive:true});const root=await fs.mkdtemp(path.join(__dirname,'../work/test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const lib=path.join(root,'后期包');await fs.mkdir(lib);return {root,lib,roots:[{path:lib,names:['后期包']}]};}
test('Mac NFD path resolves to untouched NFC file, including decomposed directories',async t=>{const f=await fixture(t);await fs.mkdir(path.join(f.lib,'ゲーム'));const p=path.join(f.lib,'ゲーム','ピアノ.wav');await fs.writeFile(p,'audio');const r=await Core.resolve(fs,'/Volumes/Mac/后期包/ゲーム/ピアノ.wav'.normalize('NFD'),f.roots);assert.equal(r.status,'match');assert.equal(r.path,Core.native(p));assert.equal((await fs.readdir(path.dirname(p)))[0],'ピアノ.wav');});
test('new BGM added after a miss is discovered without normalizing names',async t=>{const f=await fixture(t),old='/Volumes/X/后期包/ゲーム.mp3'.normalize('NFD');assert.equal((await Core.resolve(fs,old,f.roots)).status,'missing');await fs.writeFile(path.join(f.lib,'ゲーム.mp3'),'new');assert.equal((await Core.resolve(fs,old,f.roots)).status,'match');});
test('ambiguous canonical names are never chosen',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.lib,'ピ.wav'),'one');await fs.writeFile(path.join(f.lib,'ピ.wav'.normalize('NFD')),'two');assert.equal((await Core.resolve(fs,'/Volumes/X/后期包/ピ.wav',f.roots)).status,'ambiguous');});
test('separate libraries containing the same suffix are ambiguous',async t=>{const f=await fixture(t),other=path.join(f.root,'other');await fs.mkdir(other);for(const dir of [f.lib,other])await fs.writeFile(path.join(dir,'ピ.wav'),'audio');assert.equal((await Core.resolve(fs,'/Volumes/X/后期包/ピ.wav',[...f.roots,{path:other,names:['后期包']}])).status,'ambiguous');});
test('directory suffix is required and unrelated similarly named files ignored',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.lib,'ピ.wav'),'audio');assert.equal((await Core.resolve(fs,'/Volumes/X/other/ピ.wav',f.roots)).status,'out_of_scope');assert.equal((await Core.resolve(fs,'/Volumes/X/后期包/sub/ピ.wav',f.roots)).status,'missing');});
test('path traversal rejected; zero bytes and unsupported files ignored',async t=>{const f=await fixture(t);await assert.rejects(Core.resolve(fs,'/Volumes/X/后期包/../秘密.wav',f.roots));await fs.writeFile(path.join(f.lib,'空.wav'),'');assert.equal((await Core.resolve(fs,'/Volumes/X/后期包/空.wav',f.roots)).status,'missing');assert.equal((await Core.resolve(fs,'/Volumes/X/后期包/a.prproj',f.roots)).status,'unsupported');});
function clip(old){return {path:old,offline:true,calls:[],async getMediaFilePath(){return this.path},async isOffline(){return this.offline},async canChangeMediaPath(){return true},async hasProxy(){return false},async isMergedClip(){return false},async isMulticamClip(){return false},async isSequence(){return false},async changeMediaFilePath(p,override){this.calls.push([p,override]);this.path=p;this.offline=false;return true},async refreshMedia(){return true}};}
async function transaction(t){const f=await fixture(t),old='/Volumes/X/后期包/ピ.wav'.normalize('NFD');await fs.writeFile(path.join(f.lib,'ピ.wav'),'audio');return {fs,clip:clip(old),old,roots:f.roots,target:await Core.resolve(fs,old,f.roots),validate:async()=>true,journal:async()=>{},delay:async()=>{}};}
test('successful relink preserves compatibility checks and journals before mutation',async t=>{const o=await transaction(t),stages=[];o.journal=async row=>{stages.push(row.stage);if(row.stage==='prepared')assert.equal(o.clip.calls.length,0)};assert.equal((await Core.relink(o)).status,'linked');assert.equal(o.clip.calls[0][1],false);assert.deepEqual(stages,['prepared','path_changed','verified']);});
test('online references remain unchanged',async t=>{const o=await transaction(t);o.clip.offline=false;assert.equal((await Core.relink(o)).status,'became_online');assert.equal(o.clip.calls.length,0);});
test('journal failure or changed project prevents mutation',async t=>{const o=await transaction(t);o.journal=async()=>{throw new Error('disk full')};await assert.rejects(Core.relink(o),/disk full/);assert.equal(o.clip.calls.length,0);o.journal=async()=>{};o.validate=async()=>false;await assert.rejects(Core.relink(o),/工程已切换/);assert.equal(o.clip.calls.length,0);});
test('candidate replacement, changed reference and proxies prevent mutation',async t=>{const o=await transaction(t);await fs.writeFile(o.target.path,'replaced-longer');await assert.rejects(Core.relink(o),/候选文件/);assert.equal(o.clip.calls.length,0);o.clip.path='/different.wav';await assert.rejects(Core.relink(o),/引用/);o.clip.path=o.old;o.clip.hasProxy=async()=>true;assert.equal((await Core.relink(o)).status,'unsupported');assert.equal(o.clip.calls.length,0);});
test('failed host readback is recorded and never reported as linked',async t=>{const o=await transaction(t),stages=[];o.clip.refreshMedia=async()=>{o.clip.offline=true;return true};o.journal=async r=>stages.push(r.stage);await assert.rejects(Core.relink(o),/读回失败/);assert.equal(stages.at(-1),'failed');});

test('file URI variants retain exact Unicode spelling', () => {
  assert.equal(Core.native('file:/D:/BGM/%E3%83%94.wav'), 'D:/BGM/ピ.wav');
  assert.equal(Core.native('file:///D:/BGM/ピ.wav'), 'D:/BGM/ピ.wav');
  assert.equal(Core.native('file://localhost/D:/BGM/ピ.wav'), 'D:/BGM/ピ.wav');
  assert.equal(Core.native('file://server/share/BGM/ピ.wav'), '//server/share/BGM/ピ.wav');
  assert.equal(Core.sameExact('D:/ヒ\u309a.wav', 'D:/ピ.wav'), false);
  assert.equal(Core.sameExact('D:/BGM/Clip.wav', 'd:/BGM/Clip.wav'), true);
  assert.equal(Core.sameExact('D:/BGM/Clip.wav', 'D:/BGM/clip.wav'), false);
  assert.equal(Core.sameExact('/media/Clip.wav', '/media/clip.wav'), false);
});

test('missing UXP errors do not hide access or I/O failures', () => {
  assert.equal(Core.missing(new Error('No such file or directory')), true);
  assert.equal(Core.missing({code: 2}), true);
  assert.equal(Core.missing({code: 'EACCES', message: 'file not found'}), false);
  assert.equal(Core.missing(new Error('I/O error')), false);
});

test('aliases work without weakening the relative suffix; repeated anchors are ambiguous', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.lib, 'ピ.wav'), 'audio');
  const roots = [{path: f.lib, names: ['旧音楽包']}];
  assert.equal((await Core.resolve(fs, '/Volumes/X/旧音楽包/ピ.wav', roots)).status, 'match');
  assert.equal((await Core.resolve(fs, '/Volumes/X/旧音楽包/后期包/ピ.wav', roots)).status, 'ambiguous');
  assert.throws(() => Core.validateRoots([{path: f.lib, names: ['../escape']}]), /目录名/);
  assert.throws(() => Core.validateRoots([{path: 'D:/', names: ['lib']}]), /文件夹/);
});

test('references, files and ambiguity introduced during prepared logging prevent mutation', async t => {
  for (const change of ['reference', 'replace', 'ambiguous']) {
    const o = await transaction(t);
    o.journal = async row => {
      if (row.stage !== 'prepared') return;
      if (change === 'reference') o.clip.path = '/changed.wav';
      if (change === 'replace') await fs.writeFile(o.target.path, 'different audio');
      if (change === 'ambiguous') await fs.writeFile(path.join(o.roots[0].path, 'ヒ\u309a.wav'), 'another');
    };
    await assert.rejects(Core.relink(o), /引用|候选文件/);
    assert.equal(o.clip.calls.length, 0);
  }
});

test('proxy or online state introduced during logging is cancelled without mutation', async t => {
  const o = await transaction(t), stages = [];
  o.journal = async row => {
    stages.push(row.stage);
    if (row.stage === 'prepared') o.clip.hasProxy = async () => true;
  };
  assert.equal((await Core.relink(o)).status, 'unsupported');
  assert.deepEqual(stages, ['prepared', 'cancelled']);
  assert.equal(o.clip.calls.length, 0);
});

test('host refresh rejection is recorded as failure', async t => {
  const o = await transaction(t), stages = [];
  o.clip.refreshMedia = async () => false;
  o.journal = async row => stages.push(row.stage);
  await assert.rejects(Core.relink(o), /刷新/);
  assert.deepEqual(stages, ['prepared', 'path_changed', 'failed']);
});

test('directory links are skipped, including links in library ancestors', async t => {
  const f = await fixture(t), linked = path.join(f.root, 'alias');
  await fs.writeFile(path.join(f.lib, 'ピ.wav'), 'audio');
  await fs.symlink(f.lib, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const roots = [{path: linked, names: ['后期包']}];
  assert.equal((await Core.resolve(fs, '/Volumes/X/后期包/ピ.wav', roots)).status, 'missing');
});
