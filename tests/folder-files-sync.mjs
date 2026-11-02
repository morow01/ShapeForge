import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = readFileSync(new URL('../src/drive/attachments.ts', import.meta.url),'utf8');
const js = ts.transpile(code.replace(/^import .*?;\r?\n/gm,''), {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const meta = new Map(), bytes = new Map(), remote = new Map();
let calls = [], next = 0;
class DriveError extends Error { constructor(status){super();this.status=status;} }
const sync = new Function('exports','attachmentBytes','forgetAttachment','listAttachments','mutateAttachment','saveAttachment','listFolders','DriveError',js+';return exports.syncAttachments;')(
  {}, async id=>bytes.get(id),async id=>{meta.delete(id);bytes.delete(id);},async()=>[...meta.values()].map(x=>({...x})),
  async(id,fn)=>{if(meta.has(id))meta.set(id,fn(meta.get(id)));},async m=>meta.set(m.id,m),()=>[{id:'folder',driveId:'dfolder'}],DriveError);
const api = {listAll:async()=>[...remote.values()],
 upload:async o=>{calls.push(['upload',o]);const file={id:'d'+(++next),name:o.name,mimeType:o.mimeType,parents:[o.parentId],appProperties:{...o.properties,kind:o.kind}};remote.set(file.id,file);return file;},
 updateMetadata:async(id,c)=>{calls.push(['move',id,c]);const file={...remote.get(id),name:c.name,parents:c.addParent?[c.addParent]:remote.get(id).parents};remote.set(id,file);return file;},
 trash:async id=>{calls.push(['trash',id]);remote.delete(id);}};
const original = new Uint8Array([80,75,3,4,0,255,17]).buffer;
meta.set('a',{id:'a',name:'Prototype.3mf',size:7,folderId:'folder',mimeType:'application/octet-stream',dirty:true,revision:'v1'});bytes.set('a',original);
await sync(api,async id=>id?'dfolder':'root');
assert.equal(calls[0][1].name,'Prototype.3mf');assert.deepEqual(new Uint8Array(calls[0][1].body),new Uint8Array(original));assert.equal(meta.get('a').dirty,false);
meta.set('a',{...meta.get('a'),name:'Template.3mf',folderId:null,dirty:true,revision:'v2'});
await sync(api,async id=>id?'dfolder':'root');assert.equal(calls.filter(x=>x[0]==='upload').length,1);assert.equal([...remote.values()][0].name,'Template.3mf');assert.deepEqual([...remote.values()][0].parents,['root']);
meta.clear();bytes.clear();calls=[];await sync(api,async()=> 'root');assert.equal(meta.get('a').name,'Template.3mf');assert.equal(bytes.size,0,'remote files are not downloaded during sync');
meta.set('a',{...meta.get('a'),deleted:true,dirty:true});await sync(api,async()=> 'root');assert.equal(remote.size,0);assert.equal(meta.size,0);
// An upload finishing during a rename must not mark the newer metadata synced.
meta.set('b',{id:'b',name:'Notes.txt',folderId:null,mimeType:'text/plain',dirty:true,revision:'old'});bytes.set('b',original);
const upload = api.upload;api.upload=async o=>{const f=await upload(o);meta.set('b',{...meta.get('b'),name:'New notes.txt',revision:'new',dirty:true});return f;};
await sync(api,async()=> 'root');assert.equal(meta.get('b').dirty,true);assert.equal(meta.get('b').name,'New notes.txt');
console.log('Folder attachments: original bytes, metadata moves, remote discovery, deletion and concurrent rename passed.');
