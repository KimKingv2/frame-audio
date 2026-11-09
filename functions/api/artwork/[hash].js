import { error, json, requireAdmin } from "../../_lib/api.js";
const MAX=10*1024*1024;
const TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
export async function onRequest({request,env,params}) {
  const denied=await requireAdmin(request,env);
  if(denied)return denied;
  if(!env.ARTWORKS)return error("R2 binding ARTWORKS 尚未設定。",503);
  const hash=String(params.hash||"").toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(hash))return error("SHA-256 格式不正確。");
  const key="artwork/"+hash;
  if(request.method==="PUT"){
    const type=(request.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
    if(!TYPES.has(type))return error("只允許 JPEG、PNG、WebP 或 GIF。",415);
    if(Number(request.headers.get("content-length")||0)>MAX)return error("封面超過 10 MiB。",413);
    const data=await request.arrayBuffer();
    if(!data.byteLength||data.byteLength>MAX)return error("封面大小無效。",413);
    const digest=await crypto.subtle.digest("SHA-256",data);
    const actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
    if(actual!==hash)return error("封面 SHA-256 不符。",400);
    try{
      await env.ARTWORKS.put(key,data,{httpMetadata:{contentType:type,cacheControl:"private, max-age=86400"},customMetadata:{sha256:hash}});
      return json({ok:true,key,sha256:hash,sizeBytes:data.byteLength});
    }catch{return error("寫入 R2 失敗。",503);}
  }
  if(request.method==="GET"){
    try{
      const object=await env.ARTWORKS.get(key);
      if(!object)return error("找不到封面。",404);
      const headers=new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag",object.httpEtag);
      headers.set("cache-control","private, max-age=86400");
      headers.set("x-content-type-options","nosniff");
      return new Response(object.body,{headers});
    }catch{return error("讀取 R2 失敗。",503);}
  }
  return error("Method Not Allowed",405);
}
