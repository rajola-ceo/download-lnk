import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter,once} from 'node:events';
import http from 'node:http';
import {isPublicIP,checkedURL,createNetwork,mediaHeader,probeFile,parseRange} from '../lib/net.mjs';
import {sanitizeTorrent} from '../lib/torrent.mjs';
import {DownloadService,titleKey,validateCatalog} from '../lib/service.mjs';
import {configuration,createHandler} from '../server.mjs';
const hosts=['files.example','archive.org','*.archive.org'];
const film=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(2048,1)]);
const src=(extra={})=>({kind:'direct',provider:'Test',url:'https://files.example/video.mp4',...extra});
const catalog=()=>({titles:[{type:'movie',tmdbId:10378,title:'Big Buck Bunny',credit:'Blender Foundation',license:'https://creativecommons.org/licenses/by/3.0/',permissionSource:'https://peach.blender.org/about/',variants:[{id:'bbb',quality:'Source',format:'MP4',sources:[src()]}]}]});
function response(bytes,status=200,headers={}){const r=Readable.from([bytes]);r.statusCode=status;r.headers=headers;return r;}
const network=()=>({bytes:async()=>Buffer.from('{}'),open:async(url,opt={})=>response(opt.headers?.Range?film.subarray(0,1024):film,opt.headers?.Range?206:200,{'content-type':'video/mp4',...(opt.headers?.Range?{'content-range':`bytes 0-1023/${film.length}`,'content-length':'1024'}:{'content-length':String(film.length)})})});
const service=extra=>new DownloadService({catalog:catalog(),network:network(),pool:{active:new Map(),async close(){},async release(){}},publicURL:'https://download-lnk.onrender.com',hosts,...extra});
const query={type:'movie',tmdbId:10378};
test('URL and DNS rules block private addresses and unconfigured hosts',async()=>{
 assert.equal(checkedURL('https://files.example/movie.mp4',hosts).hostname,'files.example');
 for(const url of ['http://files.example/x','https://localhost/x','https://127.0.0.1/x','https://files.example:8080/x','https://u:p@files.example/x','https://files.example.evil/x'])assert.throws(()=>checkedURL(url,hosts));
 for(const ip of ['127.0.0.1','10.2.3.4','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(isPublicIP(ip),false,ip);
 assert.equal(isPublicIP('93.184.216.34'),true);
 const n=createNetwork({hosts,lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>assert.fail()});await assert.rejects(n.open('https://files.example/a.mp4'));
});
test('redirects are revalidated before following',async()=>{
 let calls=0;const n=createNetwork({hosts,lookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,opt,cb)=>{calls++;const r=new EventEmitter();r.setTimeout=()=>{};r.end=()=>cb(response(Buffer.alloc(0),302,{location:'http://127.0.0.1/secret'}));return r;}});await assert.rejects(n.open('https://files.example/x'));assert.equal(calls,1);
});
test('video probes use actual bytes and size, never HTML',async()=>{
 assert.equal(mediaHeader(film,'video/mp4'),true);assert.equal(mediaHeader(Buffer.from('<html>denied</html>'),'video/mp4'),false);assert.equal((await probeFile(network(),'https://files.example/a.mp4')).sizeBytes,film.length);
 await assert.rejects(probeFile({open:async()=>response(Buffer.from('<html>no</html>'),200,{'content-type':'text/html'})},'https://files.example/x'));
});
test('byte ranges support suffix and resume; malformed ranges fail',()=>{
 assert.deepEqual(parseRange('bytes=10-19',100),{start:10,end:19});assert.deepEqual(parseRange('bytes=-10',100),{start:90,end:99});assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99});for(const v of ['bytes=100-','bytes=20-10','bytes=0-1,4-5','bytes=-0','invalid'])assert.throws(()=>parseRange(v,100));
});
test('catalogue matches exact movie/episode IDs and validates sources',()=>{
 assert.notEqual(titleKey({type:'tv',tmdbId:1,season:1,episode:1}),titleKey({type:'tv',tmdbId:1,season:1,episode:2}));assert.throws(()=>titleKey({type:'tv',tmdbId:1}));assert.throws(()=>titleKey({type:'movie',tmdbId:'1 or 1=1'}));const c=catalog();c.titles[0].variants[0].sources[0].url='https://evil.test/x';assert.throws(()=>validateCatalog(c,hosts));
});
test('resolution returns verified sizes and hides upstream links',async t=>{
 const s=service();t.after(()=>s.close());const r=await s.resolve(query);assert.equal(r.available,true);assert.equal(r.options[0].sizeBytes,film.length);assert.ok(!JSON.stringify(r).includes('files.example'));assert.equal((await s.resolve({type:'movie',tmdbId:999})).available,false);
});
test('failed primary source falls back to working secondary source',async t=>{
 const c=catalog();c.titles[0].variants[0].sources.push(src({provider:'Backup',url:'https://files.example/backup.mp4'}));const n=network(),open=n.open;n.open=(url,opt)=>{if(url.includes('video.mp4'))throw Error('Offline');return open(url,opt);};const s=service({catalog:c,network:n});t.after(()=>s.close());assert.equal((await s.resolve(query)).options[0].providers[0],'Backup');
});
test('Archive adapter verifies the configured file in metadata',async t=>{
 const c=catalog();c.titles[0].variants[0].sources=[{kind:'archive',provider:'Archive',identifier:'item',filename:'video.mp4'}];const n=network();n.bytes=async()=>Buffer.from(JSON.stringify({files:[{name:'video.mp4'}]}));const s=service({catalog:c,network:n});t.after(()=>s.close());assert.equal((await s.resolve(query)).available,true);
});
test('parallel retries share one job; access tokens and file tickets are checked',async t=>{
 const s=service();t.after(()=>s.close());const body={...query,optionId:'bbb',clientRequestId:'abc12345-abc12345'};const [a,b]=await Promise.all([s.create(body),s.create(body)]);assert.equal(a.id,b.id);await new Promise(r=>setTimeout(r,0));const j=s.authorized(a.id,a.jobToken);assert.equal(j.status,'ready');assert.throws(()=>s.authorized(a.id,'wrong'));const u=new URL(s.publicJob(j).downloadUrl);assert.equal(s.ticket(j.id,u.searchParams).id,j.id);u.searchParams.set('signature','0'.repeat(64));assert.throws(()=>s.ticket(j.id,u.searchParams));
});
test('expired jobs are removed and cannot download',async t=>{
 let now=Date.now();const s=service({clock:()=>now,ttlMs:1000});t.after(()=>s.close());const a=await s.create({...query,optionId:'bbb',clientRequestId:'abc12345-abc12345'});now+=1001;assert.throws(()=>s.authorized(a.id,a.jobToken));await s.sweep();assert.equal(s.jobs.size,0);
});
function encode(v){if(Buffer.isBuffer(v))return Buffer.concat([Buffer.from(v.length+':'),v]);if(typeof v==='number')return Buffer.from('i'+v+'e');if(Array.isArray(v))return Buffer.concat([Buffer.from('l'),...v.map(encode),Buffer.from('e')]);return Buffer.concat([Buffer.from('d'),...Object.keys(v).sort().flatMap(k=>[encode(Buffer.from(k)),encode(v[k])]),Buffer.from('e')]);}
function metadata(extra={}){return encode({announce:Buffer.from('http://127.0.0.1/x'),'url-list':Buffer.from('http://169.254.169.254/secret'),info:{name:Buffer.from('movie.mp4'),length:100,'piece length':100,pieces:Buffer.alloc(20),...extra}});}
test('torrent metadata strips trackers/web seeds while retaining info hash',()=>{const a=sanitizeTorrent(metadata(),1024);assert.equal(a.total,100);assert.ok(!a.buffer.includes(Buffer.from('127.0.0.1')));assert.ok(!a.buffer.includes(Buffer.from('169.254')));assert.match(a.hash,/^[a-f0-9]{40}$/);assert.equal(sanitizeTorrent(a.buffer,1024).hash,a.hash);});
test('torrent metadata rejects path traversal and excessive storage',()=>{assert.throws(()=>sanitizeTorrent(metadata({name:Buffer.from('../escape')}),1024));assert.throws(()=>sanitizeTorrent(metadata({length:99999}),1024));assert.throws(()=>sanitizeTorrent(metadata({files:[{length:100,path:[Buffer.from('..'),Buffer.from('secret')]}]}),1024));assert.throws(()=>sanitizeTorrent(Buffer.from('invalid'),1024));});
test('HTTP endpoints enforce CORS and deliver real attachment bytes',async t=>{
 const s=service(),config=configuration({CLIENT_ORIGINS:'https://vidr00m.netlify.app'}),server=http.createServer(createHandler(s,config));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await s.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const r=await fetch(base+'/api/v1/resolve',{method:'POST',headers:{Origin:'https://vidr00m.netlify.app','Content-Type':'application/json'},body:JSON.stringify(query)});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'https://vidr00m.netlify.app');assert.equal((await r.json()).available,true);assert.equal((await fetch(base+'/api/v1/resolve',{method:'OPTIONS',headers:{Origin:'https://evil.test'}})).status,403);
 const a=await(await fetch(base+'/api/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...query,optionId:'bbb',clientRequestId:'abc12345-abc12345'})})).json();await new Promise(r=>setTimeout(r,0));const j=await(await fetch(base+'/api/v1/jobs/'+a.id,{headers:{Authorization:'Bearer '+a.jobToken}})).json();const u=new URL(j.downloadUrl);const file=await fetch(base+u.pathname+u.search);assert.equal(file.status,200);assert.match(file.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await file.arrayBuffer()),film);assert.equal((await fetch(base+'/api/v1/jobs/'+a.id)).status,403);
});

test('native torrent worker downloads real bytes from a local peer',{timeout:20000},async t=>{
 const {default:WebTorrent}=await import('webtorrent');const {TorrentPool}=await import('../lib/torrent.mjs');const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const dir=await mkdtemp(path.join(os.tmpdir(),'vidroom-torrent-test-'));const seed=new WebTorrent({dht:false,tracker:false,lsd:false,utp:false,natUpnp:false,natPmp:false});seed.on('error',()=>{});
 const payload=Buffer.alloc(256*1024,7);payload.name='movie.mp4';const torrent=await new Promise((resolve,reject)=>{seed.once('error',reject);seed.seed(payload,{name:'movie.mp4',announce:[]},resolve);});
 class LocalClient extends WebTorrent{constructor(opts){super({...opts,tracker:false,blocklist:[]});}add(bytes,opts,cb){const torrent=super.add(bytes,opts,cb);torrent.once('infoHash',()=>torrent.addPeer('127.0.0.1:'+seed.torrentPort));return torrent;}}
 const pool=new TorrentPool({network:{bytes:async()=>Buffer.from(torrent.torrentFile)},dir,maxBytes:1024*1024,maxActive:1,timeoutMs:12000,loadClient:async()=>({default:LocalClient})});
 t.after(async()=>{await pool.close();await new Promise(r=>seed.destroy(r));await rm(dir,{recursive:true,force:true});});
 let last=0;const result=await pool.prepare({key:'local',url:'https://files.example/movie.torrent'},p=>last=p.progress);const chunks=[];for await(const chunk of result.file.createReadStream())chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),Buffer.from(payload));assert.equal(last,1);assert.equal(result.sizeBytes,payload.length);
});

test('DNS lookup pins public results for both Node lookup callback shapes',async()=>{
 let checked=false;const n=createNetwork({hosts,lookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,options,cb)=>{options.lookup('files.example',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);});options.lookup('files.example',{},(error,address,family)=>{assert.equal(address,'93.184.216.34');assert.equal(family,4);});checked=true;const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>cb(response(Buffer.alloc(0)));return req;}});const r=await n.open('https://files.example/x');r.destroy();assert.equal(checked,true);
});
