import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createNetwork, DownloadError, reject } from './lib/net.mjs';
import { TorrentPool } from './lib/torrent.mjs';
import { DownloadService } from './lib/service.mjs';

const number=(value,fallback,min,max)=>{const n=value===undefined||value===''?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid numeric server setting');return n;};
export function configuration(env=process.env){
  const publicURL=new URL(env.PUBLIC_URL||'https://download-lnk.onrender.com');if(publicURL.protocol!=='https:'||publicURL.username||publicURL.password||publicURL.pathname!=='/'||publicURL.search||publicURL.hash)throw Error('PUBLIC_URL must be an HTTPS origin');
  const origins=(env.CLIENT_ORIGINS||'https://vidr00m.netlify.app,https://rajola-ceo.github.io').split(',').map(v=>v.trim()).filter(Boolean);
  for(const origin of origins){const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:')throw Error('CLIENT_ORIGINS must contain HTTPS origins without paths or trailing slashes');}
  const hosts=(env.ALLOWED_SOURCE_HOSTS||'download.blender.org,webtorrent.io,archive.org,*.archive.org').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);if(hosts.some(h=>!/^\*?\.?[a-z0-9.-]+$/.test(h)))throw Error('Invalid source host');
  return {publicURL:publicURL.origin,origins,hosts,enableTorrents:env.ENABLE_TORRENTS!=='false',dir:env.DOWNLOAD_DIR||'/tmp/vidroom-downloads',maxBytes:number(env.MAX_TORRENT_BYTES,2147483648,1048576,20*1024**3),maxActive:number(env.MAX_ACTIVE_TORRENTS,1,1,4),ttlMs:number(env.JOB_TTL_SECONDS,1800,60,7200)*1000,timeoutMs:number(env.TORRENT_TIMEOUT_SECONDS,900,30,3600)*1000,secret:env.DOWNLOAD_SIGNING_SECRET||undefined,port:number(env.PORT,3000,0,65535)};
}
async function body(req){let bytes=0,parts=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)reject(413,'too_large','Request too large.');parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString());}catch{reject(400,'invalid_json','Invalid request.');}}
export function createHandler(service,config){
  const requests=new Map();let totalWindow=Date.now(),total=0;
  const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));};
  const allow=(ip)=>{const now=Date.now();if(now-totalWindow>60000){requests.clear();totalWindow=now;total=0;}const n=(requests.get(ip)||0)+1;requests.set(ip,n);return ++total<=1500&&n<=180;};
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Vary','Origin');
    const origin=req.headers.origin;
    if(origin&&!config.origins.includes(origin)){json(res,403,{error:{code:'origin_not_allowed',message:'This address cannot use downloads.'}});return;}
    if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, Range');res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range, Content-Disposition');
    if(req.method==='OPTIONS'){res.statusCode=204;res.end();return;}
    try{
      const url=new URL(req.url,'https://download.invalid');
      if(req.method==='GET'&&url.pathname==='/health'){json(res,200,{ok:true,service:'download-lnk',version:'1.0.0',torrentsEnabled:config.enableTorrents,catalogueTitles:service.catalog.titles.length});return;}
      const candidate=String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim(),ip=isIP(candidate)?candidate:req.socket?.remoteAddress||'unknown';
      if(!allow(ip)){res.setHeader('Retry-After','60');reject(429,'slow_down','Please wait a moment and retry.');}
      if(req.method==='GET'&&url.pathname==='/'){json(res,200,{service:'VIDROOM Downloads',health:'/health',catalogue:'/api/v1/catalog',frontend:config.origins[0]});return;}
      if(req.method==='GET'&&url.pathname==='/api/v1/catalog'){json(res,200,{titles:service.catalog.titles.map(t=>({type:t.type,tmdbId:t.tmdbId,season:t.season,episode:t.episode,title:t.title,credit:t.credit,license:t.license}))});return;}
      if(req.method==='POST'&&url.pathname==='/api/v1/resolve'){json(res,200,await service.resolve(await body(req)));return;}
      if(req.method==='POST'&&url.pathname==='/api/v1/jobs'){json(res,202,await service.create(await body(req)));return;}
      let match=/^\/api\/v1\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
      if(match){const token=/^Bearer (\S+)$/.exec(req.headers.authorization||'')?.[1];if(req.method==='GET'){json(res,200,service.publicJob(service.authorized(match[1],token)));return;}if(req.method==='DELETE'){await service.cancel(match[1],token);json(res,200,{cancelled:true});return;}}
      match=/^\/api\/v1\/files\/([a-f0-9-]{36})$/.exec(url.pathname);if(match&&['GET','HEAD'].includes(req.method)){await service.deliver(service.ticket(match[1],url.searchParams),req,res);return;}
      reject(404,'not_found','Download endpoint not found.');
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const safe=error instanceof DownloadError;const reference=randomUUID().slice(0,8);
      if(!safe)console.error('Download request failed',{reference,name:error.name});
      res.removeHeader('Content-Disposition');json(res,safe?error.status:503,{error:{code:safe?error.code:'service_unavailable',message:safe?error.message:'Downloads are temporarily unavailable. Please try again.',...(!safe?{reference}:{})}});
    }
  };
}
export async function start(){
  const config=configuration(),network=createNetwork({hosts:config.hosts});
  const catalog=JSON.parse(await readFile(new URL('./catalog.json',import.meta.url),'utf8'));
  const pool=new TorrentPool({...config,network});const service=new DownloadService({...config,network,pool,catalog});
  const server=http.createServer(createHandler(service,config));server.requestTimeout=125000;server.headersTimeout=15000;
  server.listen(config.port,'0.0.0.0',()=>console.log('download-lnk listening',{port:config.port,titles:catalog.titles.length,torrents:config.enableTorrents}));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;server.close();server.closeAllConnections();await service.close();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  return {server,service,config};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)start().catch(error=>{console.error('Download server startup failed',{name:error.name,message:error.message});process.exitCode=1;});
