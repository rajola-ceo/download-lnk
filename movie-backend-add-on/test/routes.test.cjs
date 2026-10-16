const test=require('node:test');const assert=require('node:assert/strict');
const install=require('../tmdb-extra-routes.cjs');
function fixture(options={}){
 const routes=new Map(),calls=[];
 install({get(path,handler){routes.set(path,handler);}},{apiKey:'fixture-key',fetch:async(url,settings)=>{calls.push({url,settings});return {ok:true,json:async()=>url.includes('/images')?{id:1,logos:[{file_path:'/studio.png'}]}:{id:2,runtime:42}};},...options});
 async function call(path,params,query={}){let status=200,data;await routes.get(path)({params,query},{status(value){status=value;return this;},json(value){data=value;return this;}});return {status,data};}
 return {routes,calls,call};
}
test('movie and TV logo routes forward image-language filters and cache duplicate calls',async()=>{
 const f=fixture();const path='/api/tmdb/:type/:id/images';
 const [a,b]=await Promise.all([f.call(path,{type:'movie',id:'533535'},{include_image_language:'en,null'}),f.call(path,{type:'movie',id:'533535'},{include_image_language:'en,null'})]);
 assert.equal(a.status,200);assert.equal(b.data.logos[0].file_path,'/studio.png');assert.equal(f.calls.length,1);
 const url=new URL(f.calls[0].url);assert.equal(url.hostname,'api.themoviedb.org');assert.equal(url.pathname,'/3/movie/533535/images');assert.equal(url.searchParams.get('include_image_language'),'en,null');assert.equal(url.searchParams.get('api_key'),'fixture-key');
 await f.call(path,{type:'tv',id:'79744'});assert.match(f.calls[1].url,/\/tv\/79744\/images/);
});
test('episode route preserves season zero and exact episode coordinates',async()=>{
 const f=fixture();const result=await f.call('/api/tmdb/tv/:id/season/:season/episode/:episode',{id:'79744',season:'0',episode:'2'});assert.equal(result.data.runtime,42);assert.match(f.calls[0].url,/\/tv\/79744\/season\/0\/episode\/2/);
});
test('invalid paths and languages never reach upstream',async()=>{
 const f=fixture();assert.equal((await f.call('/api/tmdb/:type/:id/images',{id:'../x',type:'movie'})).status,400);assert.equal((await f.call('/api/tmdb/:type/:id/images',{id:'1',type:'movie'},{include_image_language:'<script>'})).status,400);assert.equal(f.calls.length,0);
});
test('upstream errors are friendly and contain no credentials',async()=>{
 const f=fixture({fetch:async()=>({ok:false,status:401})});const result=await f.call('/api/tmdb/:type/:id/images',{id:'1',type:'movie'});assert.equal(result.status,502);assert.ok(!JSON.stringify(result).includes('fixture-key'));
});
