import { getOpenListFileInfo } from "./openlist-client.js?v=20261111-server-secrets1";
import { parseSynchronizedLyrics } from "./player-effects.js?v=20261111-flac-lyrics2";

const PERIODS = [["week","近 7 日"],["month","近 30 日"],["year","近 365 日"],["all","全部時間"]];

export function initLibraryUI(options = {}) {
  const root = document.querySelector("#library-content");
  const audio = document.querySelector("#audio-player");
  const $ = selector => document.querySelector(selector);
  const state = {
    view:"music",lastLibraryView:"music",tracks:[],folders:[],shows:[],episodes:[],loaded:false,loadedAt:0,busy:false,
    selectedShowId:"",selectedAlbum:null,search:"",searchComposing:false,items:[],itemType:"track",reportPeriod:"week",reportType:"episode",
    errors:[],currentItem:null,queue:[],queueIndex:-1,session:null,tickAt:0,speed:1,
    lastProgressSave:0,restorePositionMs:0,playRequestId:0,artworkUrls:new Set(),
    preloadEntry:null,preloadAudio:null,preloadGeneration:0,
    playMode:"sequential",shuffleEnabled:false,shuffleOrder:[],shufflePosition:-1,
    lyricsCues:[],lyricsPlainLines:[],lyricsActiveIndex:-1
  };
  const PLAY_MODES=["sequential","repeat-one","repeat-all"];
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
  function loadPlayerPreferences(){try{const saved=JSON.parse(localStorage.getItem("frame-audio-player-preferences")||"{}");if(PLAY_MODES.includes(saved.playMode))state.playMode=saved.playMode;state.shuffleEnabled=saved.shuffleEnabled===true;}catch{}}
  function savePlayerPreferences(){try{localStorage.setItem("frame-audio-player-preferences",JSON.stringify({playMode:state.playMode,shuffleEnabled:state.shuffleEnabled}));}catch{}}
  function updatePlayerModeButton(){const button=$("#player-mode");if(!button)return;const config={sequential:{icon:"→",label:"順序播放"},"repeat-one":{icon:"↻¹",label:"單曲循環"},"repeat-all":{icon:"↻",label:"列表循環"}}[state.playMode]||{icon:"→",label:"順序播放"};button.textContent=config.icon;button.title=config.label;button.setAttribute("aria-label",config.label);button.classList.toggle("active",state.playMode!=="sequential");audio.loop=false;}
  function updateShuffleButton(){const button=$("#player-shuffle");if(!button)return;button.textContent="⤨";button.title=state.shuffleEnabled?"隨機播放：開啟":"隨機播放：關閉";button.setAttribute("aria-label",button.title);button.setAttribute("aria-pressed",String(state.shuffleEnabled));button.classList.toggle("active",state.shuffleEnabled);}
  function rebuildShuffleOrder(currentIndex=state.queueIndex){
    const order=state.queue.map((_,index)=>index);
    if(state.shuffleEnabled&&order.length>1){
      const current=order.indexOf(currentIndex);
      if(current>=0)order.splice(current,1);
      for(let i=order.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
      if(currentIndex>=0&&currentIndex<state.queue.length)order.unshift(currentIndex);
    }
    state.shuffleOrder=order;
    state.shufflePosition=order.indexOf(currentIndex);
  }

  function clearNextPreload() {
    state.preloadGeneration += 1;
    const entry = state.preloadEntry;
    state.preloadEntry = null;
    state.preloadAudio = null;
    const warmedAudio = entry?.audio;
    if (warmedAudio) {
      try { warmedAudio.pause(); } catch {}
      try { warmedAudio.removeAttribute("src"); warmedAudio.load(); } catch {}
    }
  }
  function nextQueueIndex(delta = 1) {
    if (!state.queue.length || state.queueIndex < 0 || !state.currentItem) return -1;
    if (state.shuffleEnabled) {
      if (state.shuffleOrder.length !== state.queue.length) rebuildShuffleOrder(state.queueIndex);
      let position = state.shuffleOrder.indexOf(state.queueIndex);
      if (position < 0) {
        rebuildShuffleOrder(state.queueIndex);
        position = state.shufflePosition;
      }
      let targetPosition = position + delta;
      if (targetPosition < 0 || targetPosition >= state.shuffleOrder.length) {
        if (state.playMode !== "repeat-all") return -1;
        if (state.queue.length === 1) return state.queueIndex;
        rebuildShuffleOrder(state.queueIndex);
        targetPosition = delta > 0 ? 1 : state.shuffleOrder.length - 1;
      }
      return state.shuffleOrder[targetPosition] ?? -1;
    }
    let target = state.queueIndex + delta;
    if (delta > 0 && target >= state.queue.length) {
      if (state.playMode !== "repeat-all") return -1;
      target = 0;
    }
    return target >= 0 && target < state.queue.length ? target : -1;
  }
  function maybePreloadNextItem() {
    if (!state.currentItem || audio.paused || state.playMode === "repeat-one") return;
    const durationSeconds = Number.isFinite(audio.duration)
      ? audio.duration
      : Number(state.currentItem.durationMs || 0) / 1000;
    if (!(durationSeconds > 0) || durationSeconds - Number(audio.currentTime || 0) > 30) return;

    const targetIndex = nextQueueIndex(1);
    if (targetIndex < 0 || targetIndex === state.queueIndex) return;
    const item = state.queue[targetIndex];
    if (!item?.id || !pathOf(item)) return;
    if (state.preloadEntry?.itemId === item.id && state.preloadEntry?.path === pathOf(item)) return;

    clearNextPreload();
    const config = getConfig();
    if (!config.connected || !config.storageReady || !config.baseUrl) return;

    const generation = state.preloadGeneration;
    const entry = {
      itemId: item.id,
      path: pathOf(item),
      itemType: state.currentItem.itemType,
      generation,
      info: null,
      audio: null,
      promise: null
    };
    state.preloadEntry = entry;
    console.info("[FRAME Audio] Next-track preload started", { remainingSeconds: Math.max(0, Math.round(durationSeconds - audio.currentTime)) });

    entry.promise = getOpenListFileInfo({
      baseUrl: config.baseUrl,
      path: entry.path,
      timeoutMs: 60000
    }).then(info => {
      if (state.preloadEntry !== entry || state.preloadGeneration !== generation) return null;
      if (!info || info.is_dir || !info.raw_url) throw new Error("下一首音訊沒有有效的播放網址。");
      entry.info = info;

      const warmedAudio = new Audio();
      warmedAudio.preload = "auto";
      warmedAudio.src = info.raw_url;
      entry.audio = warmedAudio;
      state.preloadAudio = warmedAudio;
      try { warmedAudio.load(); } catch {}
      console.info("[FRAME Audio] Next-track file info ready", { sizeBytes: Number(info.size || 0), warmedAudio: true, transport: "direct-raw-url" });
      return info;
    }).catch(error => {
      if (state.preloadEntry === entry && state.preloadGeneration === generation) {
        entry.failed = true;
        console.warn("[FRAME Audio] Next-track preload failed", { message: String(error?.message || error).slice(0, 120) });
      }
      return null;
    });
  }

  function currentLyrics() {
    const item=state.currentItem,raw=Array.isArray(item?.lyrics)?item.lyrics:item?.lyrics?[item.lyrics]:[];
    const parsed=parseSynchronizedLyrics(raw);
    state.lyricsCues=parsed.cues;state.lyricsPlainLines=parsed.plainLines;state.lyricsActiveIndex=-1;
    return parsed;
  }
  function lyricsMarkup(parsed,className="lyrics-line") {
    if(parsed.cues.length)return parsed.cues.map((cue,index)=>'<button class="'+className+'" data-lyric-index="'+index+'" type="button">'+esc(cue.text)+'</button>').join("");
    if(parsed.plainLines.length)return parsed.plainLines.map(line=>'<p class="lyrics-plain-line">'+esc(line)+'</p>').join("");
    return '<div class="lyrics-empty">這首音訊沒有讀到歌詞。<br>若 FLAC 原始標籤含 LRC 時間戳，請單獨重新索引這首歌曲。</div>';
  }
  function renderLyricsPanel() {
    const item=state.currentItem,list=$("#lyrics-list"),title=$("#lyrics-title"),subtitle=$("#lyrics-subtitle"),status=$("#lyrics-status");
    if(!list)return;const parsed=currentLyrics();
    if(title)title.textContent=item?.title||"尚未選擇音訊";
    if(subtitle)subtitle.textContent=item?.subtitle||item?.album||"";
    list.innerHTML=lyricsMarkup(parsed);
    if(status)status.textContent=parsed.cues.length?"同步歌詞 · "+parsed.cues.length+" 個時間點。點擊歌詞可跳轉。":parsed.plainLines.length?"目前讀到的是純文字歌詞，沒有可辨識的時間戳。":"沒有讀到內嵌歌詞。";
    syncLyricsHighlight();
  }
  function renderNowPlaying() {
    const item=state.currentItem;
    if(!item){root.innerHTML='<div class="now-playing-empty"><button class="secondary" data-action="back-now-playing">← 返回曲庫</button><h2>尚未播放音訊</h2><p>從 Music 或 Podcast 選擇內容後，這裡會顯示目前歌曲與同步歌詞。</p></div>';return;}
    const parsed=currentLyrics(),kind=item.itemType==="episode"?"PODCAST":"MUSIC",artist=item.subtitle||item.albumArtist||item.album||"";
    root.innerHTML='<section class="now-playing-page">'+
      '<div class="now-playing-topbar"><button class="secondary" data-action="back-now-playing">← 返回曲庫</button><span class="kicker">NOW PLAYING</span><span class="now-playing-kind">'+kind+'</span></div>'+
      '<div class="now-playing-main">'+
       '<div class="now-playing-track"><div class="now-playing-art" id="now-playing-art"><span>'+esc(String(item.title||"FA").slice(0,1).toUpperCase())+'</span></div>'+
        '<div class="now-playing-track-copy"><span class="kicker">CURRENT TRACK</span><h1>'+esc(item.title||"未命名音訊")+'</h1><p>'+esc(artist)+'</p><div class="now-playing-track-meta"><span>'+kind+'</span><span>'+duration(item.durationMs)+'</span></div></div>'+
        (item.itemType==="track"&&pathOf(item)&&typeof options.reindexMusic==="function"?'<button class="secondary now-playing-reindex" data-action="reindex-current-lyrics">重新讀取這首歌的標籤</button>':"")+
        '<p class="now-playing-reindex-status" id="now-playing-reindex-status" role="status"></p></div>'+
       '<section class="now-playing-lyrics-panel" aria-label="同步歌詞"><div class="now-playing-lyrics-heading"><span class="kicker">LYRICS</span><span>'+(parsed.cues.length?parsed.cues.length+" 個時間點":parsed.plainLines.length?"純文字歌詞":"尚無歌詞")+'</span></div>'+
        '<div class="now-playing-lyrics-list" id="now-playing-lyrics-list" aria-live="polite">'+lyricsMarkup(parsed,"now-playing-lyric-line")+'</div></section>'+
      '</div></section>';
    syncNowPlayingArtwork(item);syncLyricsHighlight();
  }
  function syncNowPlayingArtwork(item) {
    const host=$("#now-playing-art");if(!host||!item?.artworkHash)return;
    fetch("/api/artwork/"+item.artworkHash,{credentials:"same-origin"}).then(response=>response.ok?response.blob():null).then(blob=>{
      if(!blob||state.currentItem?.id!==item.id||state.view!=="now-playing")return;
      const url=URL.createObjectURL(blob);state.artworkUrls.add(url);host.style.backgroundImage="url('"+url+"')";host.classList.add("has-artwork");
      const fallback=host.querySelector("span");if(fallback)fallback.hidden=true;
    }).catch(()=>{});
  }
  function syncLyricsHighlight() {
    if((state.view!=="now-playing"&&!$("#lyrics-dialog")?.open)||!state.lyricsCues.length)return;
    const time=Number(audio.currentTime||0);let low=0,high=state.lyricsCues.length-1,active=-1;
    while(low<=high){const mid=(low+high)>>1;if(state.lyricsCues[mid].time<=time){active=mid;low=mid+1;}else high=mid-1;}
    state.lyricsActiveIndex=active;
    for(const list of [$("#lyrics-list"),$("#now-playing-lyrics-list")].filter(Boolean)){
      list.querySelectorAll("[data-lyric-index]").forEach((node,index)=>node.classList.toggle("active",index===active));
      const current=active>=0?list.querySelector('[data-lyric-index="'+active+'"]'):null;
      current?.scrollIntoView?.({block:"center",behavior:"smooth"});
    }
  }
  function animateLibraryContent(){root.classList.remove("view-enter");void root.offsetWidth;root.classList.add("view-enter");}
  function openModal(dialog){if(!dialog||dialog.open)return;try{dialog.showModal();}catch{dialog.setAttribute("open","");}}
  async function api(url,init={}) {
    const headers=new Headers(init.headers||{});
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
    root.querySelectorAll("img[data-art-hash]").forEach(async img=>{
      const hash=img.dataset.artHash;if(!/^[a-f0-9]{64}$/i.test(hash))return;
      try{
        const res=await fetch("/api/artwork/"+hash,{credentials:"same-origin"});
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
        '<div class="media-copy"><strong title="'+esc(item.title)+'">'+esc(item.title)+'</strong><span>'+esc(item.subtitle||item.path)+'</span>'+
        (type==="track"&&item.album?'<button class="album-link" type="button" data-action="open-track-album" data-index="'+i+'" title="開啟專輯">'+esc(item.album)+'</button>':"")+
        '</div><span class="media-duration">'+duration(item.durationMs)+'</span><button class="play-button" data-action="play" data-index="'+i+'" aria-label="播放">▶</button></article>';
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
  function albumArtistDisplay(tracks) {
    const albumArtists=[...new Set(tracks.map(t=>String(t.albumArtist||"").trim()).filter(Boolean))];
    const trackArtists=[...new Set(tracks.flatMap(t=>(t.artists||[]).map(a=>String(a||"").trim())).filter(Boolean))];
    const artists=albumArtists.length===1?albumArtists:[...new Set([...albumArtists,...trackArtists])];
    if(!artists.length)return "未知藝人";
    return artists.length>3?artists.slice(0,2).join(" / ")+" 等 "+artists.length+" 位藝人":artists.join(" / ");
  }
  function normalizeAlbumName(value) {
    return String(value||"")
      .normalize("NFKC")
      .replace(/[\p{Cf}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu,"")
      .replace(/[\s\u00A0]+/gu," ")
      .trim()
      .normalize("NFC")
      .toLocaleLowerCase();
  }
  function displayAlbumTagVariant(value) {
    return Array.from(String(value||"")).map(char=>{
      const codePoint=char.codePointAt(0);
      if(/[\p{Cf}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u.test(char)||(/\s/u.test(char)&&char!==" ")){
        return "[U+"+codePoint.toString(16).toUpperCase().padStart(4,"0")+"]";
      }
      return char;
    }).join("");
  }
  function albumReindexMatchKey(value) {
    return normalizeAlbumName(value).replace(/[\p{P}\p{S}\p{M}\p{C}\s]/gu,"");
  }
  function trackArtistKeys(track) {
    return [track.albumArtist,...(track.artists||[])]
      .map(value=>normalizeAlbumName(value))
      .filter(Boolean);
  }
  function renderAlbums() {
    const map=new Map();
    for(const track of state.tracks){
      const rawName=String(track.album||"").trim();
      const normalizedName=normalizeAlbumName(rawName);
      const name=rawName||"未分類專輯";
      const trackArtist=String(track.albumArtist||"").trim()||(track.artists||[]).join(" / ")||"未知藝人";
      const key=normalizedName?"album:"+normalizedName:"unknown:"+normalizeAlbumName(trackArtist);
      if(!map.has(key))map.set(key,{title:name,tracks:[],albumNameVariants:new Set()});
      const album=map.get(key);
      album.tracks.push(track);
      if(rawName)album.albumNameVariants.add(rawName);
    }
    const albums=[...map.values()].map(album=>({...album,artist:albumArtistDisplay(album.tracks),albumNameVariants:[...album.albumNameVariants]}))
      .filter(a=>!state.search||[a.title,a.artist].join(" ").toLocaleLowerCase().includes(state.search.toLocaleLowerCase()))
      .sort((a,b)=>a.title.localeCompare(b.title,"zh-Hant"));
    const duplicateCandidates=new Map();
    for(const album of albums){
      if(!album.albumNameVariants.length)continue;
      const diagnosticKey=normalizeAlbumName(album.title).replace(/[\p{P}\p{S}\s]/gu,"");
      if(!diagnosticKey)continue;
      if(!duplicateCandidates.has(diagnosticKey))duplicateCandidates.set(diagnosticKey,[]);
      duplicateCandidates.get(diagnosticKey).push(album);
    }
    const albumsWithDiagnostics=albums.map(album=>{
      const diagnosticKey=normalizeAlbumName(album.title).replace(/[\p{P}\p{S}\s]/gu,"");
      const candidates=duplicateCandidates.get(diagnosticKey)||[];
      return {...album,possibleDuplicates:candidates.filter(candidate=>candidate!==album)};
    });
    state.items=albumsWithDiagnostics;state.itemType="album";
    root.innerHTML=searchBar("搜尋專輯或專輯藝人")+sectionHead("ALBUMS","專輯",'<span class="library-muted">'+albumsWithDiagnostics.length+' 張</span>')+
      '<div class="media-card-grid">'+albumsWithDiagnostics.slice(0,300).map((a,i)=>'<button class="media-card" data-action="open-album" data-index="'+i+'">'+
      cover(artworkOf(a.tracks[0]),a.title,"media-card-cover")+'<strong>'+esc(a.title)+'</strong><span>'+esc(a.artist)+'</span><small>'+a.tracks.length+' 首</small></button>').join("")+'</div>';
    loadCovers();
  }
  function albumRefreshTargetCount(album) {
    const albumKey=albumReindexMatchKey(album?.title);
    if(!albumKey)return album?.tracks?.length||0;
    const artistKeys=new Set((album?.tracks||[]).flatMap(trackArtistKeys));
    return state.tracks.filter(track=>
      albumReindexMatchKey(track.album)===albumKey &&
      (!artistKeys.size||trackArtistKeys(track).some(key=>artistKeys.has(key))) &&
      Boolean(pathOf(track))
    ).length;
  }
  async function refreshAlbumMetadata() {
    const album=state.selectedAlbum;
    if(!album)return;
    const albumKey=albumReindexMatchKey(album.title);
    const artistKeys=new Set((album.tracks||[]).flatMap(trackArtistKeys));
    const targets=state.tracks.filter(track=>
      albumReindexMatchKey(track.album)===albumKey &&
      (!artistKeys.size||trackArtistKeys(track).some(key=>artistKeys.has(key))) &&
      Boolean(pathOf(track))
    );
    const status=$("#album-reindex-status");
    const button=root.querySelector('[data-action="refresh-album-metadata"]');
    if(!targets.length){if(status){status.hidden=false;status.textContent="找不到可重新讀取的曲目。";}return;}
    if(typeof options.reindexMusic!=="function"){if(status){status.hidden=false;status.textContent="目前無法啟動單曲索引。";}return;}
    const credentials=getConfig();
    if(!credentials.connected||!credentials.storageReady){
      if(status){status.hidden=false;status.textContent="請先連接 VPS Alist，並測試 Cloudflare D1 / R2。";}
      return;
    }
    const approved=window.confirm(
      "準備重新讀取 "+targets.length+" 首同名／疑似同名歌曲的音訊標籤，並更新 Cloudflare D1 索引。"+
      "\n原始音訊不會修改；封面會沿用 R2 去重保存。"+
      "\n\n要繼續嗎？"
    );
    if(!approved)return;
    if(button)button.disabled=true;
    if(status){status.hidden=false;status.textContent="正在準備重新讀取 "+targets.length+" 首歌曲……";}
    let succeeded=0;
    const failures=[];
    for(let index=0;index<targets.length;index++){
      const track=targets[index];
      if(status)status.textContent="重新讀取 "+(index+1)+"/"+targets.length+"："+(track.title||pathOf(track));
      const result=await options.reindexMusic(pathOf(track));
      if(result?.ok)succeeded++;
      else failures.push({path:pathOf(track),error:result?.error||"索引失敗"});
    }
    const summary="完成：成功更新 "+succeeded+" / "+targets.length+" 首。"+
      (failures.length?"\n失敗 "+failures.length+" 首：\n"+failures.slice(0,5).map(item=>item.path+"（"+item.error+"）").join("\n"):"");
    state.selectedAlbum=null;
    state.view="albums";
    state.loaded=false;
    await load(true);
    const notice=document.createElement("div");
    notice.className="library-message "+(failures.length?"is-error":"is-success");
    notice.textContent=summary;
    root.prepend(notice);
  }
  function orderedAlbumTracks(tracks) {
    const order = value => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : Number.MAX_SAFE_INTEGER;
    };
    return [...(tracks || [])].sort((a,b) =>
      order(a.discNumber)-order(b.discNumber) ||
      order(a.trackNumber)-order(b.trackNumber) ||
      String(a.title||"").localeCompare(String(b.title||""),"zh-Hant")
    );
  }
  function renderAlbumDetail() {
    const album=state.selectedAlbum;
    if(!album){state.view="albums";renderAlbums();return;}
    const tracks=orderedAlbumTracks(album.tracks);
    const years=[...new Set(tracks.map(t=>Number(t.year)).filter(y=>Number.isInteger(y)&&y>0))];
    const yearLabel=years.length===1?String(years[0]):"";
    const totalDuration=tracks.reduce((sum,t)=>sum+Math.max(0,Number(t.durationMs)||0),0);
    const details=[yearLabel,tracks.length+" 首歌曲",duration(totalDuration)].filter(Boolean).join(" · ");
    const tagVariants=album.albumNameVariants||[];
    const tagDiagnostic=tagVariants.length>1
      ?'<details class="album-tag-diagnostic"><summary>已合併 '+tagVariants.length+' 種專輯標籤寫法</summary><ul>'+tagVariants.map(value=>'<li><code>'+esc(displayAlbumTagVariant(value))+'</code></li>').join("")+'</ul></details>'
      :"";
    const possibleDuplicates=album.possibleDuplicates||[];
    const duplicateDiagnostic=possibleDuplicates.length
      ?'<details class="album-tag-diagnostic"><summary>另有 '+possibleDuplicates.length+' 組可能重複的專輯（尚未自動合併）</summary><ul>'+possibleDuplicates.map(candidate=>'<li>'+esc(candidate.title)+' · '+esc(candidate.artist)+' · '+candidate.tracks.length+' 首'+(candidate.albumNameVariants.length?' · '+candidate.albumNameVariants.map(value=>esc(displayAlbumTagVariant(value))).join(" / "):"")+'</li>').join("")+'</ul></details>'
      :"";
    root.innerHTML='<button class="back-link" data-action="back-albums">← 所有專輯</button>'+
      '<div class="show-detail album-detail">'+cover(artworkOf(tracks[0]),album.title,"show-detail-cover")+
      '<div><span class="kicker">ALBUM</span><h3>'+esc(album.title)+'</h3><p>'+esc(album.artist||"未知歌手")+'</p>'+
      '<span class="library-muted">'+esc(details)+'</span>'+tagDiagnostic+duplicateDiagnostic+
      '<div class="album-detail-actions"><button class="primary" data-action="play-album">▶ 播放整張專輯</button>'+
      '<button class="secondary" data-action="refresh-album-metadata">重新讀取同名專輯標籤（'+albumRefreshTargetCount(album)+' 首）</button></div>'+
      '<p class="library-muted" id="album-reindex-status" hidden></p></div></div>'+
      sectionHead("TRACK LIST","曲目清單",'<span class="library-muted">'+tracks.length+' 首</span>')+
      trackRows(tracks,"track");
    loadCovers();
  }

  function openAlbumFromTrack(track){
    const key=normalizeAlbumName(track?.album);if(!key)return;
    const tracks=state.tracks.filter(item=>normalizeAlbumName(item.album)===key);
    if(!tracks.length)return;
    state.selectedAlbum={
      title:String(track.album),tracks,artist:albumArtistDisplay(tracks),
      albumNameVariants:[...new Set(tracks.map(item=>String(item.album||"").trim()).filter(Boolean))],
      possibleDuplicates:[]
    };
    state.view="album-detail";renderAlbumDetail();animateLibraryContent();
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
      case "album-detail":renderAlbumDetail();break;
      case "artists":renderArtists();break;
      case "folders":renderFolders();break;
      case "shows":renderShows();break;
      case "show-detail":renderShowDetail();break;
      case "continue":void renderContinue().catch(e=>message(e.message,"error"));break;
      case "reports":void renderReports().catch(e=>message(e.message,"error"));break;
      case "errors":void renderErrors().catch(e=>message(e.message,"error"));break;
      case "now-playing":renderNowPlaying();break;
      default:renderHome();
    }
    document.body.classList.toggle("is-podcast-view",["shows","show-detail","continue"].includes(state.view));
    document.body.classList.toggle("is-now-playing",state.view==="now-playing");
    animateLibraryContent();
  }

  function setDock(item) {
    $("#player-title").textContent=item?.title||"尚未選擇音訊";
    $("#player-subtitle").textContent=item?.subtitle||item?.path||"連接私人音訊庫後即可播放";
    $("#player-type").textContent=item?.itemType==="episode"?"PODCAST":item?"MUSIC":"READY";
    const nowTile=$("#player-now-playing");if(nowTile)nowTile.disabled=!item;
    if($("#lyrics-dialog")?.open)renderLyricsPanel();
    if(state.view==="now-playing")renderNowPlaying();
    const lyricsButton=$("#player-lyrics");
    if(lyricsButton)lyricsButton.disabled=!item;
    const coverNode=$("#player-cover");coverNode.textContent=(item?.title||"FA").slice(0,1).toUpperCase();coverNode.style.backgroundImage="";
    if(item?.artworkHash) {
      fetch("/api/artwork/"+item.artworkHash,{credentials:"same-origin"}).then(r=>r.ok?r.blob():null).then(blob=>{
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
  function isPlaybackInterruption(error) {
    const messageText=String(error?.message||error||"");
    return error?.name==="AbortError" ||
      /play\(\).*interrupted|interrupted by a call to pause|interrupted by a new load request/i.test(messageText);
  }
  async function playItem(type,raw,queue=[raw],index=0,playOptions={}) {
    const selectionStartedAt=performance.now();
    const requestId=++state.playRequestId;
    const isCurrentRequest=()=>requestId===state.playRequestId;
    const config=getConfig();
    if(!config.connected||!config.storageReady||!config.baseUrl){message("伺服器端 VPS Alist 或 Cloudflare 連線尚未就緒。","error");$("#open-settings")?.click();return;}
    const item=playable(raw,type);
    if(!item.path||!item.id){message("這筆索引缺少檔案路徑或識別碼。","error");return;}

    const cachedEntry=state.preloadEntry?.itemId===item.id&&state.preloadEntry?.path===item.path
      ? state.preloadEntry : null;
    if(!cachedEntry)clearNextPreload();

    try {
      const infoStartedAt=performance.now();
      const infoRequest=cachedEntry?.promise
        ? cachedEntry.promise.then(info=>info||getOpenListFileInfo({baseUrl:config.baseUrl,path:item.path,timeoutMs:60000}))
        : getOpenListFileInfo({baseUrl:config.baseUrl,path:item.path,timeoutMs:60000});
      const infoPromise=infoRequest.then(info=>({info,elapsedMs:Math.round(performance.now()-infoStartedAt)}));
      const progressStartedAt=performance.now();
      const progressPromise=type==="episode"
        ? api("/api/listening?view=progress&itemType="+type+"&itemId="+encodeURIComponent(item.id))
            .then(data=>({data,elapsedMs:Math.round(performance.now()-progressStartedAt)}))
            .catch(()=>({data:{item:null},elapsedMs:Math.round(performance.now()-progressStartedAt)}))
        : Promise.resolve({data:{item:null},elapsedMs:0});
      const [infoResult,progressResult]=await Promise.all([infoPromise,progressPromise]);
      const info=infoResult.info;
      const saved=progressResult.data;
      const fileInfoElapsedMs=infoResult.elapsedMs;
      const progressLookupMs=progressResult.elapsedMs;
      console.info("[FRAME Audio] Playback preparation", {
        fileInfoMs:fileInfoElapsedMs,
        podcastProgressMs:type==="episode"?progressLookupMs:null,
        source:cachedEntry?"preload":"api",
        sizeBytes:Number(info?.size||0),
        transport:"direct-raw-url"
      });
      if(!isCurrentRequest())return;
      if(!info||info.is_dir)throw new Error("VPS Alist 回傳的項目是資料夾，不是音訊檔案。");
      if(!info.raw_url)throw new Error("VPS Alist /api/fs/get 沒有提供 raw_url。");
      if(!Number.isFinite(Number(info.size))||Number(info.size)<=0)throw new Error("VPS Alist 沒有提供有效檔案大小。");

      // Every item uses the Alist raw_url directly. The browser follows the
      // source's HTTP redirects; Pages never relays or transcodes audio.
      audio.removeAttribute("crossorigin");

      accountTime();persistSession(false);saveProgress(true);
      if(!audio.paused) {
        const pauseDone = new Promise(resolve => audio.addEventListener("pause", resolve, { once: true }));
        audio.pause();
        await pauseDone;
      }
      if(!isCurrentRequest())return;

      state.currentItem=item;
      if(playOptions.preserveQueue){
        state.queueIndex=index;
        if(state.shuffleOrder.length!==state.queue.length)rebuildShuffleOrder(index);
        state.shufflePosition=state.shuffleOrder.indexOf(index);
      }else{
        state.queue=queue.map(x=>({...x}));
        state.queueIndex=index;
        rebuildShuffleOrder(index);
      }
      state.session=null;
      state.restorePositionMs=type==="episode"?Number(saved.item?.position_ms||0):0;
      state.lastProgressSave=0;
      state.speed=type==="episode"&&Number.isFinite(Number(saved.item?.playback_rate))
        ?Math.min(2,Math.max(.5,Number(saved.item.playback_rate))):1;
      $("#player-speed").value=String(state.speed);
      setDock(item);
      $("#player-type").textContent=(type==="episode"?"PODCAST":"MUSIC")+" · VPS ALIST";

      const mediaLoadStartedAt=performance.now();
      const warmedAudio=cachedEntry?.audio||null;
      if(cachedEntry&&state.preloadEntry===cachedEntry){
        state.preloadEntry=null;
        state.preloadAudio=null;
      }
      audio.src=info.raw_url;
      audio.load();
      audio.playbackRate=state.speed;
      if(warmedAudio){
        const releaseWarm=()=>{
          warmedAudio.pause();
          warmedAudio.removeAttribute("src");
          try{warmedAudio.load();}catch{}
        };
        if(audio.readyState>=1)releaseWarm();
        else{
          audio.addEventListener("loadedmetadata",releaseWarm,{once:true});
          audio.addEventListener("error",releaseWarm,{once:true});
        }
      }
      try {
        await audio.play();
        if(!isCurrentRequest())return;
        console.info("[FRAME Audio] Playback started", {
          fileInfoMs:fileInfoElapsedMs,
          podcastProgressMs:type==="episode"?progressLookupMs:null,
          mediaStartMs:Math.round(performance.now()-mediaLoadStartedAt),
          totalMs:Math.round(performance.now()-selectionStartedAt),
          transport:"direct-raw-url-302"
        });
        $("#player-toggle").textContent="Ⅱ";
      } catch(e) {
        if(!isCurrentRequest()||isPlaybackInterruption(e))return;
        $("#player-toggle").textContent="▶";
        message("VPS Alist 音訊網址已載入，但瀏覽器未能開始播放。"+(e.message?" "+e.message:""),"error");
      }
    }catch(e){
      if(!isCurrentRequest())return;
      message("VPS Alist 播放失敗（未切換其他來源）："+(e.message||e),"error");
    }
  }

  function next(delta) {
    if (!state.queue.length || state.queueIndex < 0 || !state.currentItem) return;
    if (delta < 0 && Number(audio.currentTime || 0) > 3) {
      audio.currentTime = 0;
      return;
    }
    const target = nextQueueIndex(delta);
    if (target < 0 || target >= state.queue.length) return;
    void playItem(state.currentItem.itemType, state.queue[target], state.queue, target, { preserveQueue: true });
  }
  async function reindexError(i) {
    const entry=state.errors[i];if(!entry)return;
    const input=root.querySelector('[data-error-path="'+i+'"]'),newPath=String(input?.value||"").trim();
    const status=$("#error-status"),button=root.querySelector('[data-action="reindex-error"][data-index="'+i+'"]');
    if(!newPath.startsWith("/")||newPath.includes("\0")){if(status)status.textContent="路徑必須以 / 開頭，且不能包含空字元。";return;}
    if(button)button.disabled=true;if(status)status.textContent="正在單獨更新索引："+newPath;
    try{
      const cfg=getConfig();if(!cfg.connected||!cfg.storageReady)throw new Error("請先測試伺服器端 VPS Alist 與 Cloudflare 連線。");
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
    const lyricLine=event.target.closest("[data-lyric-index]");
    if(lyricLine&&root.contains(lyricLine)){
      const cue=state.lyricsCues[Number(lyricLine.dataset.lyricIndex)];
      if(cue&&Number.isFinite(cue.time)){audio.currentTime=cue.time;syncLyricsHighlight();}
      return;
    }
    const b=event.target.closest("[data-action]");if(!b)return;
    const action=b.dataset.action,i=Number(b.dataset.index);
    try{
      if(action==="navigate"){showView(b.dataset.view);return;}
      if(action==="back-now-playing"){showView(state.lastLibraryView||"music");return;}
      if(action==="reindex-current-lyrics"){
        const item=state.currentItem,button=b,status=$("#now-playing-reindex-status");
        if(!item||item.itemType!=="track"||typeof options.reindexMusic!=="function")return;
        button.disabled=true;if(status)status.textContent="正在單獨重新讀取這首 FLAC 的原生 Vorbis 歌詞標籤……";
        try{
          const result=await options.reindexMusic(pathOf(item));
          if(!result?.ok)throw new Error(result?.error||"單首重新索引失敗。");
          state.loaded=false;await load(true);
          const updated=state.tracks.find(track=>track.id===item.id||pathOf(track)===pathOf(item));
          if(updated)state.currentItem=playable(updated,"track");
          setDock(state.currentItem);
          if(state.view==="now-playing")renderNowPlaying();
          const latest=$("#now-playing-reindex-status");
          if(latest)latest.textContent="PASS：已更新本首歌的歌詞與標籤，原始音訊未修改。";
        }catch(error){if(status)status.textContent="重新索引失敗："+(error.message||error);button.disabled=false;}
        return;
      }
      if(action==="open-show"){state.selectedShowId=b.dataset.id;state.view="show-detail";renderShowDetail();animateLibraryContent();return;}
      if(action==="open-album"){state.selectedAlbum=state.items[i]||null;state.view="album-detail";renderAlbumDetail();animateLibraryContent();return;}
      if(action==="open-track-album"){openAlbumFromTrack(state.items[i]);return;}
      if(action==="back-albums"){state.view="albums";renderAlbums();animateLibraryContent();return;}
      if(action==="back-shows"){state.view="shows";state.selectedShowId="";renderShows();animateLibraryContent();return;}
      if(action==="play"){
        const item=state.items[i];
        if(state.itemType==="continue"){
          const p=item;await playItem("episode",{id:p.item_id,title:p.title,showTitle:p.subtitle,path:p.path,artworkHash:p.artwork_hash,durationMs:p.duration_ms},[item],0);
        }else await playItem(state.itemType,item,state.items,i);
        return;
      }
      if(action==="play-album"){
        const list=orderedAlbumTracks(state.selectedAlbum?.tracks||[]);
        if(list.length)await playItem("track",list[0],list,0);return;
      }
      if(action==="refresh-album-metadata"){await refreshAlbumMetadata();return;}
      if(action==="play-show"){
        const show=state.shows.find(s=>s.id===state.selectedShowId),list=state.episodes.filter(e=>e.showId===show?.id).map(e=>({...e,showTitle:show.title}));
        if(list.length)await playItem("episode",list[0],list,0);return;
      }
      if(action==="play-group"){
        const group=state.items[i];if(!group)return;
        let list=[];
        if(state.itemType==="artist")list=group[1];
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
  function refreshSearchResults(input) {
    if(!input)return;
    state.search=input.value;
    const start=input.selectionStart,end=input.selectionEnd;
    render();
    const replacement=$("#library-search");
    if(replacement){
      replacement.focus({preventScroll:true});
      if(Number.isInteger(start)&&Number.isInteger(end)){
        try{replacement.setSelectionRange(start,end);}catch{}
      }
    }
  }
  root.addEventListener("compositionstart",event=>{
    if(event.target.id==="library-search")state.searchComposing=true;
  });
  root.addEventListener("compositionend",event=>{
    if(event.target.id!=="library-search")return;
    state.searchComposing=false;
    refreshSearchResults(event.target);
  });
  root.addEventListener("input",event=>{
    if(event.target.id!=="library-search")return;
    state.search=event.target.value;
    if(state.searchComposing||event.isComposing)return;
    refreshSearchResults(event.target);
  });
  audio.addEventListener("error",()=>{
    if(!state.currentItem||!audio.src)return;
    const code=audio.error?audio.error.code:"未知";
    $("#player-toggle").textContent="▶";
    $("#player-type").textContent="VPS ALIST ERROR";
    $("#player-subtitle").textContent="VPS Alist 音訊載入失敗，MediaError code："+code+"。未自動切換其他來源。";
    console.error("[FRAME Audio] VPS Alist HTML5 Audio MediaError code:",code);
  });
  audio.addEventListener("play",()=>{startSession();$("#player-toggle").textContent="Ⅱ";document.body.classList.add("is-audio-playing");});
  audio.addEventListener("pause",()=>{accountTime();persistSession(false);saveProgress(true);$("#player-toggle").textContent="▶";document.body.classList.remove("is-audio-playing");});
  audio.addEventListener("loadedmetadata",()=>{
    if(state.restorePositionMs>3000&&Number.isFinite(audio.duration)&&state.restorePositionMs<audio.duration*1000-5000)audio.currentTime=state.restorePositionMs/1000;
    state.restorePositionMs=0;timeline();maybePreloadNextItem();
  });
  audio.addEventListener("timeupdate",()=>{timeline();syncLyricsHighlight();maybePreloadNextItem();});
  audio.addEventListener("ended",()=>{
    accountTime();persistSession(true);saveProgress(true);state.session=null;
    if(state.playMode==="repeat-one"){audio.currentTime=0;audio.play().catch(error=>message(error.message||"單曲循環播放失敗。","error"));}
    else if(state.shuffleEnabled||state.playMode==="repeat-all")next(1);
    else{$("#player-toggle").textContent="▶";document.body.classList.remove("is-audio-playing");}
  });
  $("#player-toggle")?.addEventListener("click",()=>{
    if(!audio.src){message("請先從曲庫選擇歌曲或 Podcast 單集。");return;}
    if(audio.paused){
      const requestId=++state.playRequestId;
      audio.play().then(()=>{
        if(requestId===state.playRequestId)$("#player-toggle").textContent="Ⅱ";
      }).catch(error=>{
        if(requestId!==state.playRequestId||isPlaybackInterruption(error))return;
        $("#player-toggle").textContent="▶";
        message(error.message||"瀏覽器無法開始播放。","error");
      });
    }else{
      state.playRequestId+=1;
      audio.pause();
    }
  });
  $("#player-prev")?.addEventListener("click",()=>next(-1));
  $("#player-next")?.addEventListener("click",()=>next(1));
  $("#player-stop")?.addEventListener("click",()=>{
    state.playRequestId+=1;
    clearNextPreload();
    accountTime();persistSession(false);saveProgress(true);audio.pause();audio.removeAttribute("src");audio.removeAttribute("crossorigin");audio.load();
    state.currentItem=null;state.session=null;state.queue=[];state.queueIndex=-1;state.shuffleOrder=[];state.shufflePosition=-1;setDock(null);timeline();
  });
  $("#player-seek")?.addEventListener("change",e=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number(e.target.value)/1000;});
  $("#player-speed")?.addEventListener("change",e=>{state.speed=Math.min(2,Math.max(.5,Number(e.target.value)||1));audio.playbackRate=state.speed;if(state.currentItem?.itemType==="episode")saveProgress(true);});

  $("#player-shuffle")?.addEventListener("click",()=>{
    state.shuffleEnabled=!state.shuffleEnabled;
    clearNextPreload();
    rebuildShuffleOrder(state.queueIndex);
    updateShuffleButton();
    savePlayerPreferences();
  });
  $("#player-mode")?.addEventListener("click",()=>{
    const index=PLAY_MODES.indexOf(state.playMode);
    state.playMode=PLAY_MODES[(index+1)%PLAY_MODES.length];
    clearNextPreload();
    updatePlayerModeButton();savePlayerPreferences();
  });
  $("#lyrics-close")?.addEventListener("click",()=>$("#lyrics-dialog")?.close());
  $("#player-lyrics")?.addEventListener("click",()=>{
    if(!state.currentItem){message("請先播放一首歌曲。");return;}
    renderLyricsPanel();openModal($("#lyrics-dialog"));syncLyricsHighlight();
  });
  $("#player-now-playing")?.addEventListener("click",()=>{
    if(!state.currentItem){message("請先從曲庫選擇音訊。");return;}
    void showView("now-playing");
  });
  $("#lyrics-list")?.addEventListener("click",event=>{
    const line=event.target.closest("[data-lyric-index]");if(!line)return;
    const cue=state.lyricsCues[Number(line.dataset.lyricIndex)];
    if(cue&&Number.isFinite(cue.time)){audio.currentTime=cue.time;syncLyricsHighlight();}
  });

  window.setInterval(()=>{if(!state.currentItem||audio.paused)return;accountTime();persistSession(false);saveProgress(false);timeline();},15000);
  window.addEventListener("pagehide",()=>{accountTime();persistSession(false);saveProgress(true);});
  async function showView(name){
    const target=name==="podcasts"?"shows":name;
    if(target==="now-playing"&&!state.currentItem){message("請先從曲庫選擇音訊。");return;}
    if(target!=="now-playing")state.lastLibraryView=target;
    state.view=target;state.search="";
    if(!state.loaded)await load(true);else render();
    animateLibraryContent();
  }
  async function refresh(){state.loaded=false;await load(true);}
  loadPlayerPreferences();updatePlayerModeButton();updateShuffleButton();
  setDock(null);void showView("music");
  return {showView,refresh,load};
}
