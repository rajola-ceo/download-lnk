import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reject } from './net.mjs';

// Parse bounded, administrator-curated metadata and remove embedded web seeds,
// trackers and peer addresses. The original info bytes remain unchanged.
export function sanitizeTorrent(data,maxBytes){
  if(data.length>2*1024*1024)reject(422,'torrent_metadata','Torrent metadata is too large.');
  let cursor=0,infoBytes;
  function value(depth=0){
    if(depth>24||cursor>=data.length)throw Error('Invalid torrent metadata');
    const start=cursor,c=data[cursor];
    if(c===105){cursor++;const end=data.indexOf(101,cursor);if(end<0)throw Error('Bad integer');const str=data.subarray(cursor,end).toString();if(!/^(0|-?[1-9]\d*)$/.test(str))throw Error('Bad integer');const n=Number(str);if(!Number.isSafeInteger(n))throw Error('Large integer');cursor=end+1;return n;}
    if(c===108||c===100){cursor++;const result=c===108?[]:Object.create(null);let count=0;while(data[cursor]!==101){if(++count>100000)throw Error('Metadata too complex');if(c===108)result.push(value(depth+1));else{const k=value(depth+1);if(!Buffer.isBuffer(k))throw Error('Bad key');const key=k.toString();if(Object.hasOwn(result,key))throw Error('Duplicate key');const before=cursor;result[key]=value(depth+1);if(depth===0&&key==='info')infoBytes=data.subarray(before,cursor);}}cursor++;return result;}
    const colon=data.indexOf(58,cursor);if(colon<0||colon-cursor>8)throw Error('Bad string');const lengthText=data.subarray(cursor,colon).toString();if(!/^(0|[1-9]\d*)$/.test(lengthText))throw Error('Bad string');const length=Number(lengthText);if(!Number.isSafeInteger(length)||length<0||colon+1+length>data.length)throw Error('Bad string');cursor=colon+1+length;return data.subarray(colon+1,cursor);
  }
  let meta;try{meta=value();if(cursor!==data.length)throw Error('Trailing bytes');}catch{reject(422,'torrent_metadata','Invalid torrent metadata.');}
  const info=meta.info;if(!info||!infoBytes||!Buffer.isBuffer(info.name)||!Buffer.isBuffer(info.pieces)||!Number.isSafeInteger(info['piece length'])||info['piece length']<1)reject(422,'torrent_metadata','Unsupported torrent metadata.');
  const validPart=v=>Buffer.isBuffer(v)&&v.length>0&&!/[\x00-\x1f/\\]/.test(v.toString())&&!['.','..'].includes(v.toString());
  if(!validPart(info.name)||info.pieces.length%20)reject(422,'torrent_path','Invalid torrent filename.');
  const files=info.files||[{length:info.length,path:[info.name]}];if(!Array.isArray(files)||!files.length||files.length>1000)reject(422,'torrent_files','Invalid torrent files.');
  let total=0;for(const file of files){if(!Number.isSafeInteger(file.length)||file.length<0||!Array.isArray(file.path)||!file.path.length||file.path.some(v=>!validPart(v)))reject(422,'torrent_path','Invalid torrent file.');total+=file.length;}
  if(!Number.isSafeInteger(total)||total<1||total>maxBytes)reject(422,'torrent_size','This torrent exceeds the server storage limit.');
  if(Math.ceil(total/info['piece length'])*20!==info.pieces.length)reject(422,'torrent_metadata','Invalid torrent piece count.');
  const hash=createHash('sha1').update(infoBytes).digest('hex');
  const tracker=Buffer.from('udp://tracker.opentrackr.org:1337/announce');
  const string=v=>Buffer.concat([Buffer.from(v.length+':'),v]);
  const buffer=Buffer.concat([Buffer.from('d8:announce'),string(tracker),Buffer.from('4:info'),infoBytes,Buffer.from('e')]);
  return {buffer,total,hash};
}
export class TorrentPool {
  constructor({network,dir,maxBytes,maxActive=1,timeoutMs=900000,loadClient=()=>import('webtorrent')}){Object.assign(this,{network,dir,maxBytes,maxActive,timeoutMs,loadClient});this.active=new Map();this.client=null;this.loading=null;}
  async getClient(){
    if(this.client)return this.client;
    if(!this.loading)this.loading=this.loadClient().then(({default:WebTorrent})=>{
      const client=new WebTorrent({dht:false,lsd:false,utPex:false,webSeeds:false,natUpnp:false,natPmp:false,utp:false,maxConns:16,uploadLimit:65536,blocklist:['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','::/0']});
      client.on('error',()=>{for(const record of this.active.values())record.fail?.(new Error('Torrent client stopped'));this.client=null;this.loading=null;});this.client=client;return client;
    }).catch(error=>{this.loading=null;throw error;});
    return this.loading;
  }
  async prepare(source,update=()=>{}){
    if(this.active.has(source.key)){const existing=this.active.get(source.key);existing.listeners.add(update);try{return await existing.promise;}finally{existing.listeners.delete(update);}}
    if(this.active.size>=this.maxActive)reject(503,'download_busy','Another movie is being prepared. Please try again shortly.');
    const record={listeners:new Set([update]),path:path.join(this.dir,randomUUID())};this.active.set(source.key,record);
    record.promise=(async()=>{
      const meta=sanitizeTorrent(await this.network.bytes(source.url),this.maxBytes);if(record.closed)throw Error('Cancelled');
      if(source.infoHash&&source.infoHash!==meta.hash)reject(502,'torrent_mismatch','Torrent does not match the configured movie.');
      if([...this.active.values()].filter(r=>r!==record).some(r=>r.hash===meta.hash))reject(503,'download_busy','This movie is already being prepared.');
      record.hash=meta.hash;await mkdir(record.path,{recursive:true});const client=await this.getClient();if(record.closed){await rm(record.path,{recursive:true,force:true});throw Error('Cancelled');}
      return new Promise((resolve,rejectPromise)=>{
        let complete=false;const timer=setTimeout(()=>fail(new Error('Torrent preparation timed out')),this.timeoutMs);timer.unref?.();
        const fail=error=>{if(complete)return;complete=true;clearTimeout(timer);rejectPromise(error);};record.fail=fail;
        try{
          const torrent=client.add(meta.buffer,{path:record.path,deselect:true,destroyStoreOnDestroy:true,storeCacheSlots:2},torrent=>{
            if(complete)return;const videos=torrent.files.filter(f=>/\.(mp4|webm|mov|mkv)$/i.test(f.path));
            const file=source.filePath?torrent.files.find(f=>f.path===source.filePath||f.name===source.filePath):videos.length===1?videos[0]:null;
            if(!file||!videos.includes(file))return fail(new Error('Movie file not found in torrent'));
            file.select();
            const progress=()=>{const downloaded=Math.min(file.length,Math.max(0,file.downloaded||0));for(const fn of record.listeners)fn({downloaded,total:file.length,progress:Math.min(1,downloaded/file.length),speed:torrent.downloadSpeed||0});};
            const done=()=>{if(complete)return;complete=true;clearTimeout(timer);torrent.removeListener('download',progress);for(const fn of record.listeners)fn({downloaded:file.length,total:file.length,progress:1,speed:0});resolve({file,sizeBytes:file.length,contentType:/\.webm$/i.test(file.name)?'video/webm':/\.mkv$/i.test(file.name)?'video/x-matroska':/\.mov$/i.test(file.name)?'video/quicktime':'video/mp4',filename:file.name,release:()=>this.release(source.key)});};
            torrent.on('download',progress);file.on('done',done);if(file.done||file.progress===1)done();else progress();
          });record.torrent=torrent;torrent.on('error',fail);
        }catch(error){fail(error);}
      });
    })().catch(async error=>{await this.release(source.key,record);throw error;}).finally(()=>record.listeners.delete(update));
    return record.promise;
  }
  async release(key,expected){const r=this.active.get(key);if(!r||expected&&r!==expected)return;this.active.delete(key);r.closed=true;r.fail?.(new Error('Preparation cancelled'));if(r.torrent&&!r.torrent.destroyed)await new Promise(resolve=>r.torrent.destroy({destroyStore:true},resolve));await rm(r.path,{recursive:true,force:true}).catch(()=>{});}
  async close(){for(const key of [...this.active.keys()])await this.release(key);if(this.client)await new Promise(resolve=>this.client.destroy(resolve));}
}
