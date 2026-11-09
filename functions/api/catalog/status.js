import { error, json, requireAdmin } from "../../_lib/api.js";
export async function onRequestGet({request,env}) {
  const denied=await requireAdmin(request,env);
  if(denied)return denied;
  if(!env.DB||typeof env.DB.prepare!=="function")return error("D1 尚未綁定，請新增名為 DB 的 D1 binding。",503);
  if(!env.ARTWORKS||typeof env.ARTWORKS.put!=="function")return error("R2 尚未綁定，請新增名為 ARTWORKS 的 R2 binding。",503);
  try{
    const [tracks,folders]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM tracks").first(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM folders").first()
    ]);
    return json({ok:true,storage:"cloudflare-d1-r2",d1:true,r2:true,tracks:Number(tracks?.count||0),folders:Number(folders?.count||0)});
  }catch{return error("D1 已綁定，但尚未初始化資料表。請執行 migrations/0001_catalog.sql。",503);}
}
