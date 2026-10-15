import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';

export class DownloadError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
export const reject=(status,code,message)=>{throw new DownloadError(status,code,message);};
export function isPublicIP(ip){
  if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  if(isIP(ip)===6){const v=ip.toLowerCase();return /^2[0-9a-f]{3}:/.test(v)&&!v.startsWith('2001:db8:')&&!v.startsWith('2001:0:')&&!v.startsWith('2002:');}
  return false;
}
export function checkedURL(input,hosts){
  let url;try{url=new URL(input);}catch{reject(422,'invalid_source','Invalid source URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||isIP(url.hostname.replace(/[\[\]]/g,'')))reject(422,'unsafe_source','Source address is not permitted.');
  const host=url.hostname.toLowerCase();
  if(!hosts.some(rule=>rule.startsWith('*.')?host.endsWith(rule.slice(1))&&host!==rule.slice(2):rule===host))reject(422,'source_host','Source host is not configured.');
  return url;
}
export function createNetwork({hosts,lookup=dns.lookup,request=https.request}={}){
  async function open(input,{method='GET',headers={},signal,redirects=0}={}){
    const url=checkedURL(input,hosts);if(redirects>4)reject(502,'redirect_limit','Source redirected too many times.');
    signal?.throwIfAborted();
    const addresses=await lookup(url.hostname,{all:true});
    if(!addresses.length||addresses.some(a=>!isPublicIP(a.address)))reject(502,'unsafe_address','Source address is not public.');
    const chosen=addresses[0];
    const response=await new Promise((resolve,rejectPromise)=>{
      const req=request(url,{method,headers:{'User-Agent':'VIDROOM-Download/1.0','Accept-Encoding':'identity',...headers},signal,lookup:(hostname,options,cb)=>options?.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family)},resolve);
      req.on('error',rejectPromise);req.setTimeout(30000,()=>req.destroy(new Error('Source timed out')));req.end();
    });
    if([301,302,303,307,308].includes(response.statusCode)){
      const location=response.headers.location;response.destroy();if(!location)reject(502,'bad_redirect','Invalid source redirect.');
      return open(new URL(location,url).href,{method,headers,signal,redirects:redirects+1});
    }
    return response;
  }
  async function bytes(url,maxBytes=2*1024*1024){
    const response=await open(url,{signal:AbortSignal.timeout(20000)});
    if(response.statusCode!==200){response.destroy();reject(502,'source_unavailable','Source is unavailable.');}
    const chunks=[];let count=0;for await(const chunk of response){count+=chunk.length;if(count>maxBytes){response.destroy();reject(502,'source_too_large','Source response is too large.');}chunks.push(chunk);}return Buffer.concat(chunks);
  }
  return {open,bytes};
}
export function mediaHeader(buffer,type=''){
  if(/^text\/|json|html|xml/i.test(type))return false;
  return buffer.length>=12&&(buffer.subarray(4,8).toString()==='ftyp'||buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))||buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='AVI '||buffer.subarray(0,4).toString()==='OggS');
}
export async function probeFile(network,url){
  const response=await network.open(url,{headers:{Range:'bytes=0-1023'},signal:AbortSignal.timeout(20000)});
  if(![200,206].includes(response.statusCode)){response.destroy();reject(502,'source_unavailable','Source is unavailable.');}
  const contentRange=response.headers['content-range'];
  const total=response.statusCode===206?Number(/\/(\d+)$/.exec(contentRange||'')?.[1]):Number(response.headers['content-length']);
  let prefix=Buffer.alloc(0);
  try{for await(const chunk of response){prefix=Buffer.concat([prefix,chunk.subarray(0,Math.max(0,1024-prefix.length))]);if(prefix.length>=1024)break;}}finally{response.destroy();}
  if(!mediaHeader(prefix,String(response.headers['content-type']||'')))reject(502,'not_video','Source did not return a video file.');
  return {sizeBytes:Number.isSafeInteger(total)&&total>0?total:null,contentType:String(response.headers['content-type']||'application/octet-stream')};
}
export function parseRange(header,size){
  if(!header)return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!m[1]&&!m[2])reject(416,'invalid_range','Invalid byte range.');
  let start,end;if(!m[1]){const n=Number(m[2]);if(!Number.isSafeInteger(n)||n<1)reject(416,'invalid_range','Invalid byte range.');start=Math.max(0,size-n);end=size-1;}else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)reject(416,'invalid_range','Invalid byte range.');
  return {start,end};
}
export function safeName(value){return String(value).replace(/[\x00-\x1f\x7f/\\:"<>|?*]/g,'_').slice(0,160)||'video';}
