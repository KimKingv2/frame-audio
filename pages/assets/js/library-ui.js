import { getOpenListFileInfo } from "./openlist-client.js";

const PERIODS = [["week","近 7 日"],["month","近 30 日"],["year","近 365 日"],["all","全部時間"]];

export function initLibraryUI(options = {}) {
  const root = document.querySelector("#library-content");
  const audio = document.querySelector("#audio-player");
  const $ = selector => document.querySelector(selector);
  const state = {
    view:"music",tracks:[],folders:[],shows:[],episodes:[],loaded:false,loadedAt:0,busy:false,
    selectedShowId:"",search:"",items:[],itemType:"track",reportPeriod:"week",reportType:"episode",
    errors:[],currentItem:null,queue:[],queueIndex:-1,session:null,tickAt:0,speed:1,
    lastProgressSave:0,restorePositionMs:0,artworkUrls:new Set()
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const duration = value => {
    const n=Math.max(0,Math.floor(Number(value||0)/1000)),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;
    return h ? h+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0") : m+":"+String(s).padStart(2,"0");
  };
  const longDuration = value => {
    const n=Math.max(0,Math.round(Number(value||0))),h=Math.floor(n/3600),m=Math.floor(n%3600/60);
    return h ? h+" 小時 "+m+" 分" : m ? m+" 分鐘" : n+" 秒";
  };
  function getConfig(){return options.getCredentials?.()||{};}
  function authToken(){const c=getConfig();if(!c.adminToken)throw new Error("請先設定並測試 Cloudflare 儲存管理金鑰。");return c.adminToken;}
  async function api(url,init={}) {
    const headers=new Headers(init.headers||{});headers.set("Authorization","Bearer "+authToken());
    if(init.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
    const response=await fetch(url,{credentials:"same-origin",...init,headers});
    let data={};try{data=await response.json();}catch{}
    if(!response.ok||data.ok===false)throw new Error(data.error||("API HTTP "+response.status));
    return data;
  }
  async function all(url) {
    const result=[];let offset=0;
    while(true){
      const sep=url.includes("?")?"&":"?";
      const page=await api(url+sep+"limit=500&offset="+offset);
      result.push(...(page.items||[]));
      if(page.nextOffset==null||page.nextOffset<=offset)break;
      offset=page.nextOffset;
    }
    return result;
  }
  function message(text,type=""){root.innerHTML='<div class="library-message '+(type?"is-"+type:"")+'">'+esc(text)+'</div>';}
  async function load(force=false) {
    if(state.busy)return;
    if(!force&&state.loaded&&Date.now()-state.loadedAt<30000){render();return;}
    state.busy=true;message("正在讀取 Music 與 Podcast 曲庫……");
    try {
      const [tracks,folders,shows,episodes]=await Promise.all([
        all("/api/catalog?kind=tracks"),all("/api/catalog?kind=folders"),
        all("/api/catalog/podcasts?kind=shows"),all("/api/catalog/podcasts?kind=episodes")
      ]);
      Object.assign(state,{tracks,folders,shows,episodes,loaded:true,loadedAt:Date.now()});
      render();
    } catch(e){message(e.message||"曲庫讀取失敗。請確認資料庫初始化狀態。","error");}
    finally{state.busy=false;}
  }
  function cover(hash,title,extra="") {
    const letter=esc(String(title||"F").trim().slice(0,1).toUpperCase()||"F");
    return '<div class="media-cover '+extra+'"><span>'+letter+'</span>'+
      (/^[a-f0-9]{64}$/i.test(String(hash||""))?'<img data-art-hash="'+hash+'" alt="" loading="lazy">':"")+'</div>';
  }
  function loadCovers() {
    revokeCovers();
    const token=getConfig().adminToken;
    if(!token)return;
    root.querySelectorAll("img[data-art-hash]").forEach(async img=>{
      const hash=img.dataset.artHash;if(!/^[a-f0-9]{64}$/i.test(hash))return;
      try{
        const res=await fetch("/api/artwork/"+hash,{headers:{Authorization:"Bearer "+token},credentials:"same-origin"});
        if(!res.ok)return;
        const url=URL.createObjectURL(await res.blob());state.artworkUrls.add(url);
        img.src=url;img.parentElement?.classList.add("has-artwork");
      }catch{}
    });
  }
  function revokeCovers(){for(const url of state.artworkUrls)URL.revokeObjectURL(url);state.artworkUrls.clear();}
  const pathOf=item=>item.file?.path||item.path||"";
  const artworkOf=item=>item.artwork?.sha256||item.artworkHash||item.artwork_hash||null;
  function playable(item,type) {
    const path=pathOf(item);
    const subtitle=type==="episode"?(item.showTitle||item.subtitle||"") :
      (item.artists?.join(" / ")||item.albumArtist||item.album||"");
    return {...item,itemType:type,path,title:item.title||path.split("/").pop()||"未命名音訊",
      subtitle,artworkHash:artworkOf(item),durationMs:Number(item.durationMs||item.duration_ms||0)};
  }
  function sectionHead(kicker,title,tail=""){return '<div class="library-section-head"><div><span class="kicker">'+esc(kicker)+'</span><h3>'+esc(title)+'</h3></div>'+tail+'</div>';}
  function stats(cards){return '<div class="summary-grid">'+cards.map(c=>'<div class="summary-card"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong></div>').join("")+'</div>';}
  function searchBar(placeholder) {
    return '<div class="library-toolbar"><input id="library-search" class="library-search" type="search" placeholder="'+esc(placeholder)+'" value="'+esc(state.search)+'">'+
      '<span class="library-muted">'+state.tracks.length.toLocaleString()+' 首音樂 · '+state.shows.length.toLocaleString()+' 個節目 · '+state.episodes.length.toLocaleString()+' 集單集</span></div>';
  }
  function trackRows(rows,type="track") {
    state.items=rows;state.itemType=type;
    if(!rows.length)return '<div class="library-empty"><div class="library-empty-mark">♫</div><h3>目前沒有項目</h3><p>完成索引後，內容就會出現在這裡。</p></div>';
    return '<div class="media-list">'+rows.map((raw,i)=>{
      const item=playable(raw,type);
      return '<article class="media-row">'+cover(item.artworkHash,item.title)+
        '<div class="media-copy"><strong title="'+esc(item.title)+'">'+esc(item.title)+'</strong><span>'+esc(item.subtitle||item.path)+'</span></div>'+
        '<span class="media-duration">'+duration(item.durationMs)+'</span><button class="play-button" data-action="play" data-index="'+i+'" aria-label="播放">▶</button></article>';
    }).join("")+'</div>';
  }
  function renderHome() {
    const recent=[...state.tracks].sort((a,b)=>String(b.file?.modifiedAt||"").localeCompare(String(a.file?.modifiedAt||""))).slice(0,8);
    root.innerHTML=stats([["MUSIC TRACKS",state.tracks.length.toLocaleString()],["PODCAST SHOWS",state.shows.length.toLocaleString()],["PODCAST EPISODES",state.episodes.length.toLocaleString()]])+
      sectionHead("RECENTLY INDEXED","最近加入的音樂",'<button class="secondary" data-action="navigate" data-view="tracks">查看全部</button>')+
      trackRows(recent,"track")+
      sectionHead("PODCASTS","你的節目",'<button class="secondary" data-action="navigate" data-view="shows">查看全部</button>')+
      showCards(state.shows.slice(0,6));
    loadCovers();
  }
  function renderTracks() {
    const q=state.search.toLocaleLowerCase();
    const rows=state.tracks.filter(t=>!q||[t.title,t.album,t.albumArtist,t.file?.path,...(t.artists||[]),...(t.genres||[])].join(" ").toLocaleLowerCase().includes(q));
    root.innerHTML=searchBar("搜尋曲名、歌手、專輯或路徑")+sectionHead("ALL TRACKS","所有歌曲",'<span class="library-muted">'+rows.length+' 首</span>')+trackRows(rows.slice(0,500),"track");
    loadCovers();
  }
  function renderAlbums() {
    const map=new Map();
    for(const track of state.tracks){const name=String(track.album||"未分類專輯"),artist=track.albumArtist||(track.artists||[]).join(" / "),key=name+"|"+artist;
      if(!map.has(key))map.set(key,{title:name,artist,tracks:[]});map.get(key).tracks.push(track);}
    const albums=[...map.values()].filter(a=>!state.search||[a.title,a.artist].join(" ").toLocaleLowerCase().includes(state.search.toLocaleLowerCase())).sort((a,b)=>a.title.localeCompare(b.title,"zh-Hant"));
    state.items=albums;state.itemType="album";
    root.innerHTML=searchBar("搜尋專輯或專輯藝人")+sectionHead("ALBUMS","專輯",'<span class="library-muted">'+albums.length+' 張</span>')+
      '<div class="media-card-grid">'+albums.slice(0,300).map((a,i)=>'<button class="media-card" data-action="play-group" data-index="'+i+'">'+
      cover(artworkOf(a.tracks[0]),a.title,"media-card-cover")+'<strong>'+esc(a.title)+'</strong><span>'+esc(a.artist||"未知藝人")+'</span><small>'+a.tracks.length+' 首</small></button>').join("")+'</div>';
    loadCovers();
  }
  function renderArtists() {
    const map=new Map();
    for(const t of state.tracks){for(const artist of (t.artists?.length?t.artists:[t.albumArtist||"未知藝人"])){if(!map.has(artist))map.set(artist,[]);map.get(artist).push(t);}}
    const artists=[...map.entries()].filter(([name])=>!state.search||name.toLocaleLowerCase().includes(state.search.toLocaleLowerCase())).sort((a,b)=>a[0].localeCompare(b[0],"zh-Hant"));
    state.items=artists;state.itemType="artist";
    root.innerHTML=searchBar("搜尋歌手")+sectionHead("ARTISTS","歌手",'<span class="library-muted">'+artists.length+' 位</span>')+
      '<div class="media-card-grid">'+artists.slice(0,300).map(([name,tracks],i)=>'<button class="artist-card" data-action="play-group" data-index="'+i+'"><span class="artist-avatar">'+esc(name.slice(0,1))+'</span><strong>'+esc(name)+'</strong><small>'+tracks.length+' 首</small></button>').join("")+'</div>';
  }
  function renderFolders() {
    const folders=state.folders.filter(f=>!state.search||[f.name,f.path].join(" ").toLocaleLowerCase().includes(state.search.toLocaleLowerCase()));
    state.items=folders;state.itemType="folder";
    root.innerHTML=searchBar("搜尋資料夾")+sectionHead("FOLDER PLAYLISTS","資料夾歌單",'<span class="library-muted">'+folders.length+' 個</span>')+
      '<div class="folder-grid">'+folders.slice(0,500).map((f,i)=>'<button class="folder-card" data-action="play-group" data-index="'+i+'"><span>▰</span><strong>'+esc(f.name)+'</strong><small>'+Number(f.recursiveTrackCount||f.directTrackCount||0)+' 首歌曲</small><em>'+esc(f.path)+'</em></button>').join("")+'</div>';
  }
  function showCards(shows) {
    if(!shows.length)return '<div class="library-empty"><div class="library-empty-mark">▤</div><h3>還沒有 Podcast 節目</h3><p>完成 Podcast 掃描後，節目會出現在這裡。</p></div>';
    const counts=new Map();for(const e of state.episodes)counts.set(e.showId,(counts.get(e.showId)||0)+1);
    return '<div class="show-grid">'+shows.map(show=>'<button class="show-card" data-action="open-show" data-id="'+esc(show.id)+'">'+
      cover(show.coverHash,show.title,"show-cover")+'<span class="show-card-copy"><strong>'+esc(show.title)+'</strong><small>'+esc(show.author||"Podcast")+
      '</small><em>'+(counts.get(show.id)||0)+' 集單集</em></span></button>').join("")+'</div>';
  }
  function renderShows() {
    const shows=state.shows.filter(s=>!state.search||[s.title,s.author,s.description].join(" ").toLocaleLowerCase().includes(state.search.toLocaleLowerCase()));
    root.innerHTML=searchBar("搜尋節目名稱或作者")+sectionHead("PODCAST SHOWS","所有節目",'<span class="library-muted">'+shows.length+' 個節目</span>')+showCards(shows);
    loadCovers();
  }
  function renderShowDetail() {
    const show=state.shows.find(s=>s.id===state.selectedShowId);if(!show){state.view="shows";renderShows();return;}
    const episodes=state.episodes.filter(e=>e.showId===show.id).sort((a,b)=>Number(a.seasonNumber||0)-Number(b.seasonNumber||0)||Number(a.episodeNumber||0)-Number(b.episodeNumber||0)||String(a.publishedAt||"").localeCompare(String(b.publishedAt||""))).map(e=>({...e,showTitle:show.title}));
    root.innerHTML='<button class="back-link" data-action="back-shows">← 所有節目</button><div class="show-detail">'+cover(show.coverHash,show.title,"show-detail-cover")+
      '<div><span class="kicker">PODCAST SHOW</span><h3>'+esc(show.title)+'</h3><p>'+esc(show.author||"Podcast")+'</p><p class="show-description">'+esc(show.description||"尚無節目簡介。")+'</p><span class="library-muted">'+episodes.length+' 集單集</span></div></div>'+
      sectionHead("EPISODES","所有單集",'<button class="primary" data-action="play-show">從頭播放</button>')+trackRows(episodes,"episode");
    loadCovers();
  }
  async function renderContinue() {
    const data=await api("/api/listening?view=continue&itemType=episode&limit=100"),items=data.items||[];
    state.items=items;state.itemType="continue";
    root.innerHTML=sectionHead("CONTINUE LISTENING","繼續收聽",'<span class="library-muted">'+items.length+' 筆進度</span>')+
      (items.length?'<div class="media-list">'+items.map((p,i)=>'<article class="media-row">'+cover(p.artwork_hash,p.title)+
        '<div class="media-copy"><strong>'+esc(p.title)+'</strong><span>'+esc(p.subtitle||"Podcast")+'</span><div class="mini-progress"><i style="width:'+Math.min(100,Number(p.position_ms||0)/Math.max(1,Number(p.duration_ms||1))*100)+'%"></i></div></div>'+
        '<span class="media-duration">'+duration(p.position_ms)+' / '+duration(p.duration_ms)+'</span><button class="play-button" data-action="play" data-index="'+i+'">▶</button></article>').join("")+'</div>':
      '<div class="library-empty"><div class="library-empty-mark">◷</div><h3>暫無續播項目</h3><p>Podcast 播放進度會自動保存，之後可以從這裡接著聽。</p></div>');
    loadCovers();
  }
  async function renderReports() {
    const type=state.reportType,period=state.reportPeriod;
    const data=await api("/api/listening?view=report&itemType="+type+"&period="+period),s=data.summary||{};
    root.innerHTML='<div class="report-controls"><div><span class="kicker">LISTENING REPORT</span><h3>收聽報告</h3></div><div class="report-switch">'+
      '<button data-action="report-type" data-value="track" class="'+(type==="track"?"active":"")+'">Music</button><button data-action="report-type" data-value="episode" class="'+(type==="episode"?"active":"")+'">Podcasts</button></div></div>'+
      '<div class="period-switch">'+PERIODS.map(([k,v])=>'<button data-action="report-period" data-value="'+k+'" class="'+(period===k?"active":"")+'">'+v+'</button>').join("")+'</div>'+
      stats([["播放次數",Number(s.plays||0).toLocaleString()],["收聽時長",longDuration(s.listenedSeconds)],["收聽項目",Number(s.distinctItems||0).toLocaleString()],["完整聽完",Number(s.completed||0).toLocaleString()]])+
      sectionHead(type==="track"?"MUSIC TRACKS":"PODCAST EPISODES","各項目收聽統計",'<span class="library-muted">依總收聽時長排序</span>')+
      ((data.items||[]).length?'<div class="report-list">'+data.items.map(i=>'<div class="report-row"><div><strong>'+esc(i.title)+'</strong><small>'+esc(i.subtitle||"")+'</small></div><b>'+Number(i.plays||0)+' 次</b><span>'+longDuration(i.listened_seconds)+'</span></div>').join("")+'</div>':
      '<div class="library-empty"><div class="library-empty-mark">◷</div><h3>這個期間還沒有收聽紀錄</h3><p>播放開始後，次數與實際收聽時長會自動累計。</p></div>');
  }
  async function renderErrors() {
    const [m,p]=await Promise.all([api("/api/catalog/retries"),api("/api/catalog/podcasts/retries")]);
    state.errors=[...(m.items||[]).map(x=>({...x,itemType:"track"})),...(p.items||[]).map(x=>({...x,itemType:"episode"}))].sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
    root.innerHTML=sectionHead("INDEX MAINTENANCE","索引錯誤與手動修復",'<button class="secondary" data-action="refresh-errors">重新整理</button>')+
      '<p class="library-description">可直接修改檔案路徑，再單獨重新讀取該首音訊的標籤並更新索引，不必重新掃描整個資料夾。成功後會將舊路徑索引與收聽紀錄接到修正後路徑；原始音訊不會被修改。</p>'+
      (state.errors.length?'<div class="error-table-wrap"><table class="error-table"><thead><tr><th>類型</th><th>原路徑與錯誤原因</th><th>修正後路徑</th><th>操作</th></tr></thead><tbody>'+
      state.errors.map((e,i)=>'<tr><td><span class="type-pill '+(e.itemType==="episode"?"podcast":"music")+'">'+(e.itemType==="episode"?"Podcast":"Music")+'</span></td>'+
      '<td><code>'+esc(e.path)+'</code><small class="error-reason">'+esc(e.message||"索引失敗")+'</small></td>'+
      '<td><input class="path-edit" data-error-path="'+i+'" value="'+esc(e.path)+'" aria-label="修正後路徑"></td>'+
      '<td><button class="primary small" data-action="reindex-error" data-index="'+i+'">單獨重新索引</button></td></tr>').join("")+
      '</tbody></table></div>':'<div class="library-empty"><div class="library-empty-mark">✓</div><h3>目前沒有待修復錯誤</h3><p>Music 與 Podcast 的失敗重試佇列都是空的。</p></div>')+
      '<div class="statusbox" id="error-status">成功索引後，對應錯誤會從清單解除。</div>';
  }
  function render() {
    if(!state.loaded){message("正在讀取曲庫……");void load(true);return;}
    switch(state.view){
      case "music":renderHome();break;
      case "tracks":renderTracks();break;
      case "albums":renderAlbums();break;
      case "artists":renderArtists();break;
      case "folders":renderFolders();break;
      case "shows":renderShows();break;
      case "show-detail":renderShowDetail();break;
      case "continue":void renderContinue().catch(e=>message(e.message,"error"));break;
      case "reports":void renderReports().catch(e=>message(e.message,"error"));break;
      case "errors":void renderErrors().catch(e=>message(e.message,"error"));break;
      default:renderHome();
    }
  }

  function setDock(item) {
    $("#player-title").textContent=item?.title||"尚未選擇音訊";
    $("#player-subtitle").textContent=item?.subtitle||item?.path||"連接私人音訊庫後即可播放";
    $("#player-type").textContent=item?.itemType==="episode"?"PODCAST":item?"MUSIC":"READY";
    const coverNode=$("#player-cover");coverNode.textContent=(item?.title||"FA").slice(0,1).toUpperCase();coverNode.style.backgroundImage="";
    if(item?.artworkHash) {
      const token=getConfig().adminToken;
      fetch("/api/artwork/"+item.artworkHash,{headers:{Authorization:"Bearer "+token}}).then(r=>r.ok?r.blob():null).then(blob=>{
        if(!blob||state.currentItem?.id!==item.id)return;
        const url=URL.createObjectURL(blob);state.artworkUrls.add(url);coverNode.style.backgroundImage="url('"+url+"')";coverNode.textContent="";
      }).catch(()=>{});
    }
  }
  function timeline() {
    const d=Number(audio.duration||0),p=Number(audio.currentTime||0);
    $("#player-seek").value=d>0?String(Math.round(p/d*1000)):"0";
    $("#player-current").textContent=duration(p*1000);
    $("#player-duration").textContent=duration((d||state.currentItem?.durationMs/1000||0)*1000);
  }
  function accountTime() {
    if(!state.session)return;
    const now=performance.now(),delta=Math.max(0,Math.min(45,(now-state.tickAt)/1000));
    state.session.listenedSeconds+=delta;state.tickAt=now;
  }
  function sessionBody(completed=false) {
    const item=state.currentItem;if(!item||!state.session)return null;
    return {action:"event",sessionId:state.session.id,itemType:item.itemType,itemId:item.id,path:item.path,title:item.title,
      subtitle:item.subtitle,startedAt:state.session.startedAt,listenedSeconds:Math.floor(state.session.listenedSeconds),
      durationSeconds:Number.isFinite(audio.duration)?audio.duration:item.durationMs/1000,completed};
  }
  function persistSession(completed=false) {
    const body=sessionBody(completed);if(body)void api("/api/listening",{method:"POST",keepalive:true,body:JSON.stringify(body)}).catch(()=>{});
  }
  function saveProgress(force=false) {
    const item=state.currentItem;if(!item||!Number.isFinite(audio.currentTime))return;
    if(!force&&Date.now()-state.lastProgressSave<12000)return;state.lastProgressSave=Date.now();
    void api("/api/listening",{method:"POST",keepalive:force,body:JSON.stringify({
      action:"progress",itemType:item.itemType,itemId:item.id,path:item.path,title:item.title,subtitle:item.subtitle,
      artworkHash:item.artworkHash,positionMs:Math.round(audio.currentTime*1000),
      durationMs:Number.isFinite(audio.duration)?Math.round(audio.duration*1000):item.durationMs||null,
      playbackRate:item.itemType==="episode"?state.speed:1
    })}).catch(()=>{});
  }
  function startSession() {
    if(!state.currentItem)return;
    if(!state.session||state.session.itemId!==state.currentItem.id||state.session.itemType!==state.currentItem.itemType){
      state.session={id:crypto.randomUUID().replace(/-/g,""),itemId:state.currentItem.id,itemType:state.currentItem.itemType,startedAt:new Date().toISOString(),listenedSeconds:0};
    }
    state.tickAt=performance.now();persistSession(false);
  }
  async function playItem(type,raw,queue=[raw],index=0) {
    const config=getConfig();
    if(!config.connected||!config.openListToken||!config.baseUrl){message("播放前請先連接 OpenList。","error");$("#open-settings")?.click();return;}
    const item=playable(raw,type);if(!item.path||!item.id){message("這筆索引缺少檔案路徑或識別碼。","error");return;}
    try {
      const [info,saved]=await Promise.all([
        getOpenListFileInfo({baseUrl:config.baseUrl,token:config.openListToken,path:item.path}),
        api("/api/listening?view=progress&itemType="+type+"&itemId="+encodeURIComponent(item.id)).catch(()=>({item:null}))
      ]);
      if(!info.raw_url)throw new Error("OpenList 沒有提供可播放的音訊網址。");
      accountTime();persistSession(false);saveProgress(true);
      if(!audio.paused) {
        const pauseDone = new Promise(resolve => audio.addEventListener("pause", resolve, { once: true }));
        audio.pause();
        await pauseDone;
      }
      state.currentItem=item;state.queue=queue.map(x=>({...x}));state.queueIndex=index;state.session=null;
      state.restorePositionMs=Number(saved.item?.position_ms||0);state.lastProgressSave=0;
      state.speed = type === "episode" && Number.isFinite(Number(saved.item?.playback_rate))
        ? Math.min(2,Math.max(.5,Number(saved.item.playback_rate))) : 1;
      $("#player-speed").value=String(state.speed);
      setDock(item);audio.src=info.raw_url;audio.load();audio.playbackRate=state.speed;
      try{await audio.play();$("#player-toggle").textContent="Ⅱ";}
      catch(e){$("#player-toggle").textContent="▶";message("音訊已載入。請按底部播放鍵繼續。"+(e.message?" "+e.message:""));}
    }catch(e){message("無法播放這個項目："+(e.message||e),"error");}
  }
  function next(delta) {
    if(!state.queue.length||state.queueIndex<0)return;
    const i=state.queueIndex+delta;if(i<0||i>=state.queue.length)return;
    void playItem(state.currentItem.itemType,state.queue[i],state.queue,i);
  }
  async function reindexError(i) {
    const entry=state.errors[i];if(!entry)return;
    const input=root.querySelector('[data-error-path="'+i+'"]'),newPath=String(input?.value||"").trim();
    const status=$("#error-status"),button=root.querySelector('[data-action="reindex-error"][data-index="'+i+'"]');
    if(!newPath.startsWith("/")||newPath.includes("\0")){if(status)status.textContent="路徑必須以 / 開頭，且不能包含空字元。";return;}
    if(button)button.disabled=true;if(status)status.textContent="正在單獨更新索引："+newPath;
    try{
      const cfg=getConfig();if(!cfg.connected||!cfg.openListToken)throw new Error("請先連接 OpenList。");
      const result=entry.itemType==="track"?await options.reindexMusic?.(newPath):await options.reindexPodcast?.(newPath);
      if(!result?.ok)throw new Error(result?.error||"索引未成功。");
      if(newPath!==entry.path){
        const moved=await options.relink?.({itemType:entry.itemType,oldPath:entry.path,newPath});
        if(moved?.ok===false)throw new Error(moved.error||"新索引成功，但舊路徑移轉失敗。");
      }
      await options.resolveRetry?.(entry.itemType,entry.path);
      if(newPath!==entry.path)await options.resolveRetry?.(entry.itemType,newPath);
      if(status)status.textContent="PASS：已更新索引「"+(result.title||newPath)+"」，錯誤已解除。";
      state.loaded=false;await load(true);await renderErrors();
    }catch(e){if(status)status.textContent="更新失敗："+(e.message||e);if(button)button.disabled=false;}
  }
  async function handleClick(event) {
    const b=event.target.closest("[data-action]");if(!b)return;
    const action=b.dataset.action,i=Number(b.dataset.index);
    try{
      if(action==="navigate"){showView(b.dataset.view);return;}
      if(action==="open-show"){state.selectedShowId=b.dataset.id;state.view="show-detail";renderShowDetail();return;}
      if(action==="back-shows"){state.view="shows";state.selectedShowId="";renderShows();return;}
      if(action==="play"){
        const item=state.items[i];
        if(state.itemType==="continue"){
          const p=item;await playItem("episode",{id:p.item_id,title:p.title,showTitle:p.subtitle,path:p.path,artworkHash:p.artwork_hash,durationMs:p.duration_ms},[item],i);
        }else await playItem(state.itemType,item,state.items,i);
        return;
      }
      if(action==="play-show"){
        const show=state.shows.find(s=>s.id===state.selectedShowId),list=state.episodes.filter(e=>e.showId===show?.id).map(e=>({...e,showTitle:show.title}));
        if(list.length)await playItem("episode",list[0],list,0);return;
      }
      if(action==="play-group"){
        const group=state.items[i];if(!group)return;
        let list=[];
        if(state.itemType==="album"||state.itemType==="artist")list=state.itemType==="album"?group.tracks:group[1];
        else if(state.itemType==="folder")list=state.tracks.filter(t=>t.file?.path===group.path||t.file?.path?.startsWith(group.path.replace(/\/$/,"")+"/"));
        if(list.length)await playItem("track",list[0],list,0);return;
      }
      if(action==="report-type"){state.reportType=b.dataset.value;await renderReports();return;}
      if(action==="report-period"){state.reportPeriod=b.dataset.value;await renderReports();return;}
      if(action==="refresh-errors"){await renderErrors();return;}
      if(action==="reindex-error"){await reindexError(i);return;}
    }catch(e){message(e.message||"操作失敗。","error");}
  }
  root.addEventListener("click",handleClick);
  root.addEventListener("input",event=>{
    if(event.target.id==="library-search"){state.search=event.target.value;const pos=event.target.selectionStart;render();const input=$("#library-search");if(input){input.focus();input.setSelectionRange(pos,pos);}}
  });
  audio.addEventListener("play",()=>{startSession();$("#player-toggle").textContent="Ⅱ";});
  audio.addEventListener("pause",()=>{accountTime();persistSession(false);saveProgress(true);$("#player-toggle").textContent="▶";});
  audio.addEventListener("loadedmetadata",()=>{
    if(state.restorePositionMs>3000&&Number.isFinite(audio.duration)&&state.restorePositionMs<audio.duration*1000-5000)audio.currentTime=state.restorePositionMs/1000;
    state.restorePositionMs=0;timeline();
  });
  audio.addEventListener("timeupdate",timeline);
  audio.addEventListener("ended",()=>{accountTime();persistSession(true);saveProgress(true);state.session=null;next(1);});
  $("#player-toggle")?.addEventListener("click",()=>{
    if(!audio.src){message("請先從曲庫選擇歌曲或 Podcast 單集。");return;}
    if(audio.paused)audio.play().catch(e=>message(e.message,"error"));else audio.pause();
  });
  $("#player-prev")?.addEventListener("click",()=>next(-1));
  $("#player-next")?.addEventListener("click",()=>next(1));
  $("#player-stop")?.addEventListener("click",()=>{
    accountTime();persistSession(false);saveProgress(true);audio.pause();audio.removeAttribute("src");audio.load();
    state.currentItem=null;state.session=null;state.queue=[];state.queueIndex=-1;setDock(null);timeline();
  });
  $("#player-seek")?.addEventListener("change",e=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number(e.target.value)/1000;});
  $("#player-speed")?.addEventListener("change",e=>{state.speed=Math.min(2,Math.max(.5,Number(e.target.value)||1));audio.playbackRate=state.speed;if(state.currentItem?.itemType==="episode")saveProgress(true);});
  window.setInterval(()=>{if(!state.currentItem||audio.paused)return;accountTime();persistSession(false);saveProgress(false);timeline();},15000);
  window.addEventListener("pagehide",()=>{accountTime();persistSession(false);saveProgress(true);});
  async function showView(name){state.view=name==="podcasts"?"shows":name;state.search="";if(!state.loaded)await load(true);else render();}
  async function refresh(){state.loaded=false;await load(true);}
  setDock(null);void showView("music");
  return {showView,refresh,load};
}
