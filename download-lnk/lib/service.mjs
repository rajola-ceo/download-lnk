import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { reject, probeFile, checkedURL, safeName, parseRange } from './net.mjs';
import { pipeline } from 'node:stream/promises';

export function titleKey(v){
  if(!v||typeof v!=='object'||Array.isArray(v))reject(422,'invalid_request','Choose a movie or episode.');
  const type=v.type;if(!['movie','tv'].includes(type))reject(422,'invalid_type','Choose a movie or episode.');
  const id=Number(v.tmdbId);if(!Number.isSafeInteger(id)||id<1)reject(422,'invalid_id','Invalid movie identifier.');
  const season=type==='tv'?Number(v.season):null,episode=type==='tv'?Number(v.episode):null;
  if(type==='tv'&&(!Number.isSafeInteger(season)||season<0||!Number.isSafeInteger(episode)||episode<1))reject(422,'invalid_episode','Choose a season and episode.');
  return `${type}:${id}${type==='tv'?`:${season}:${episode}`:''}`;
}
export function validateCatalog(catalog,hosts){
  if(!catalog||!Array.isArray(catalog.titles)||catalog.titles.length>10000)throw Error('catalog.json needs a titles array.');
  const seen=new Set(),variants=new Set();
  for(const t of catalog.titles){const key=titleKey(t);if(seen.has(key))throw Error('Duplicate title in catalogue');seen.add(key);
    if(typeof t.title!=='string'||t.title.length>200||!t.credit||!t.license||!t.permissionSource)throw Error('Every title needs title, credit, license and permissionSource.');
    if(!Array.isArray(t.variants)||!t.variants.length||t.variants.length>30)throw Error('Add up to 30 file variants per title.');
    for(const v of t.variants){if(!/^[a-zA-Z0-9_-]{1,70}$/.test(v.id)||variants.has(v.id)||typeof v.quality!=='string'||v.quality.length>40||!['MP4','MOV','WEBM','MKV'].includes(v.format)||!Array.isArray(v.sources)||!v.sources.length||v.sources.length>8)throw Error('Invalid or duplicate file variant.');variants.add(v.id);
      for(const [index,s]of v.sources.entries()){
        if(!['direct','archive','torrent'].includes(s.kind)||typeof s.provider!=='string'||s.provider.length>100)throw Error('Unsupported source.');
        if(s.kind==='archive'){if(!/^[a-zA-Z0-9_.-]{1,150}$/.test(s.identifier)||!s.filename||s.filename.length>300||!/^.*\.(mp4|mov|webm|mkv)$/i.test(s.filename)||s.filename.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p))throw Error('Invalid archive item/file.');}
        else checkedURL(s.url,hosts);
        if(s.kind==='torrent'&&s.infoHash&&!/^[a-f0-9]{40}$/.test(s.infoHash))throw Error('Invalid expected torrent hash.');
        s.key=`${v.id}:${index}`;
      }
    }
  }
  return catalog;
}
export class DownloadService {
  constructor({catalog,network,pool,publicURL,hosts,enableTorrents=true,secret=randomBytes(32).toString('hex'),ttlMs=1800000,clock=Date.now}){Object.assign(this,{catalog:validateCatalog(catalog,hosts),network,pool,publicURL,enableTorrents,secret,ttlMs,clock});this.cache=new Map();this.resolving=new Map();this.jobs=new Map();this.replays=new Map();this.timer=setInterval(()=>this.sweep(),30000);this.timer.unref();}
  getTitle(query){const key=titleKey(query);return this.catalog.titles.find(t=>titleKey(t)===key);}
  async inspect(source){
    if(source.kind==='torrent')return this.enableTorrents?{...source,kind:'torrent',sizeBytes:null,preparation:true}:null;
    let url=source.url;
    if(source.kind==='archive'){
      let meta;try{meta=JSON.parse((await this.network.bytes(`https://archive.org/metadata/${source.identifier}`)).toString());}catch{reject(502,'archive_unavailable','Archive source is unavailable.');}
      if(meta.is_dark||meta.metadata?.nodownload==='true'||meta.metadata?.nodownload===true||meta.is_collection||!meta.files?.some(f=>f.name===source.filename))reject(502,'archive_unavailable','This file is not available from the archive.');
      url=`https://archive.org/download/${source.identifier}/${source.filename.split('/').map(encodeURIComponent).join('/')}`;
    }
    return {...source,url,...await probeFile(this.network,url),preparation:false};
  }
  async resolve(query){
    const key=titleKey(query),title=this.getTitle(query);if(!title)return {available:false,title:null,options:[],reason:'No downloads are available for this title yet.'};
    const cached=this.cache.get(key);if(cached&&cached.expires>this.clock())return this.publicResolution(cached);
    if(!this.resolving.has(key))this.resolving.set(key,(async()=>{
      const entries=await Promise.all(title.variants.map(async variant=>{
        const results=await Promise.allSettled(variant.sources.map(s=>this.inspect(s)));const sources=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
        return {variant,sources};
      }));const result={title,entries,expires:this.clock()+120000};this.cache.set(key,result);return result;
    })().finally(()=>this.resolving.delete(key)));
    return this.publicResolution(await this.resolving.get(key));
  }
  publicResolution(r){return {available:r.entries.some(e=>e.sources.length),title:{type:r.title.type,tmdbId:r.title.tmdbId,title:r.title.title,credit:r.title.credit,license:r.title.license,permissionSource:r.title.permissionSource},options:r.entries.filter(e=>e.sources.length).map(({variant:v,sources})=>({id:v.id,quality:v.quality,format:v.format,sizeBytes:sources.find(s=>s.sizeBytes)?.sizeBytes||null,requiresPreparation:sources.every(s=>s.preparation),sourceCount:sources.length,providers:[...new Set(sources.map(s=>s.provider))]})),reason:'No downloads are available for this title yet.'};}
  async create(body){
    const key=titleKey(body),replay=body.clientRequestId;if(!/^[a-zA-Z0-9-]{16,80}$/.test(replay||''))reject(422,'invalid_request','Please retry your download.');
    const nonceKey=key+':'+body.optionId+':'+replay;const prev=this.replays.get(nonceKey);if(prev&&this.jobs.has(prev))return this.publicJob(this.jobs.get(prev),true);
    if(this.jobs.size>=100)reject(503,'download_busy','The download queue is full. Please try again shortly.');
    await this.resolve(body);const entry=this.cache.get(key)?.entries.find(e=>e.variant.id===body.optionId);if(!entry?.sources.length)reject(404,'unavailable','That download is not available.');
    // Two requests may complete source resolution simultaneously.
    const again=this.replays.get(nonceKey);if(again&&this.jobs.has(again))return this.publicJob(this.jobs.get(again),true);
    const job={id:randomUUID(),token:randomBytes(24).toString('hex'),status:'preparing',createdAt:this.clock(),expires:this.clock()+this.ttlMs,title:this.getTitle(body),variant:entry.variant,progress:0,downloaded:0,total:null,speed:0,nonceKey};
    this.jobs.set(job.id,job);this.replays.set(nonceKey,job.id);
    this.prepare(job,entry.sources).catch(()=>{});return this.publicJob(job,true);
  }
  async prepare(job,sources){
    for(const source of sources){
      if(job.cancelled)return;
      try{
        job.provider=source.provider;
        const result=source.kind==='torrent'?await this.pool.prepare(source,p=>{if(!job.cancelled)Object.assign(job,{progress:p.progress,downloaded:p.downloaded,total:p.total,speed:p.speed});}):{...await probeFile(this.network,source.url),url:source.url};
        if(job.cancelled)return;
        job.source=source;job.result=result;job.total=result.sizeBytes;job.status='ready';job.progress=1;job.downloaded=source.kind==='torrent'?result.sizeBytes:0;return;
      }catch(error){console.warn('Download source unavailable',{provider:source.provider,code:error.code||'preparation_failed'});}
    }
    job.status='failed';job.error='This download could not be prepared. Please try another source or try again later.';
  }
  authorized(id,token){const j=this.jobs.get(id);if(!j||j.expires<=this.clock())reject(410,'job_expired','This download expired. Please prepare it again.');if(typeof token!=='string'||token.length!==j.token.length||!timingSafeEqual(Buffer.from(token),Buffer.from(j.token)))reject(403,'forbidden','This download link is not available.');return j;}
  publicJob(j,includeToken=false){
    const data={id:j.id,status:j.status,progress:j.status==='preparing'?j.progress:null,downloadedBytes:j.downloaded,totalBytes:j.total,speedBytesPerSecond:j.speed,quality:j.variant.quality,format:j.variant.format,provider:j.provider||null,expiresAt:new Date(j.expires).toISOString(),error:j.error||null};
    if(includeToken)data.jobToken=j.token;
    if(j.status==='ready'){
      const expires=Math.min(j.expires,this.clock()+15*60000);const input=`${j.id}:${expires}`,signature=createHmac('sha256',this.secret).update(input).digest('hex');data.downloadUrl=`${this.publicURL}/api/v1/files/${j.id}?expires=${expires}&signature=${signature}`;
    }
    return data;
  }
  ticket(id,query){const expires=Number(query.get('expires')),sig=query.get('signature')||'';if(!Number.isSafeInteger(expires)||expires<=this.clock()||!/^[a-f0-9]{64}$/.test(sig))reject(403,'ticket_expired','This download link expired.');const expected=createHmac('sha256',this.secret).update(`${id}:${expires}`).digest('hex');if(!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))reject(403,'bad_ticket','Invalid download link.');const job=this.jobs.get(id);if(!job||job.status!=='ready'||job.expires<=this.clock())reject(410,'job_expired','This download is no longer available.');return job;}
  async deliver(job,req,res){
    const filename=safeName(`${job.title.title}${job.title.type==='tv'?` S${job.title.season}E${job.title.episode}`:''} - ${job.variant.quality}.${job.variant.format.toLowerCase()}`);
    res.setHeader('Content-Disposition',`attachment; filename="${filename.replace(/[^\x20-\x7e]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(job.source.kind==='torrent'){
      const size=job.result.sizeBytes;let range;try{range=parseRange(req.headers.range,size);}catch(e){res.setHeader('Content-Range',`bytes */${size}`);throw e;}
      const start=range?.start||0,end=range?.end??size-1;res.statusCode=range?206:200;res.setHeader('Content-Type',job.result.contentType);res.setHeader('Content-Length',end-start+1);res.setHeader('Accept-Ranges','bytes');if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);
      if(req.method==='HEAD'){res.end();return;}await pipeline(job.result.file.createReadStream({start,end}),res);return;
    }
    if(req.headers.range){if(job.result.sizeBytes)parseRange(req.headers.range,job.result.sizeBytes);else if(!/^bytes=\d*-\d*$/.test(req.headers.range))reject(416,'invalid_range','Invalid byte range.');}
    const controller=new AbortController();res.once('close',()=>controller.abort());
    const upstream=await this.network.open(job.result.url,{method:req.method==='HEAD'?'HEAD':'GET',headers:req.headers.range?{Range:req.headers.range}:{},signal:controller.signal});
    if(![200,206].includes(upstream.statusCode)||/text\/|html|json|xml/i.test(String(upstream.headers['content-type']||''))){upstream.destroy();reject(502,'source_unavailable','The source is unavailable. Prepare another download.');}
    res.statusCode=upstream.statusCode;res.setHeader('Content-Type',job.result.contentType);
    for(const h of ['content-length','content-range','accept-ranges'])if(upstream.headers[h])res.setHeader(h,upstream.headers[h]);
    if(req.method==='HEAD'){upstream.destroy();res.end();return;}await pipeline(upstream,res);
  }
  async sweep(){
    for(const [id,j]of this.jobs)if(j.expires<=this.clock()){j.cancelled=true;this.jobs.delete(id);this.replays.delete(j.nonceKey);}
    const used=new Set([...this.jobs.values()].filter(j=>!j.cancelled&&j.status!=='failed').flatMap(j=>j.source?.key?[j.source.key]:j.status==='preparing'?j.variant.sources.map(s=>s.key):[]));
    for(const key of [...this.pool.active.keys()])if(!used.has(key))await this.pool.release(key);
    for(const [key,r]of this.cache)if(r.expires<this.clock()-120000)this.cache.delete(key);
  }
  async cancel(id,token){const j=this.authorized(id,token);j.cancelled=true;j.status='cancelled';j.expires=this.clock();await this.sweep();}
  async close(){clearInterval(this.timer);await this.pool.close();}
}
