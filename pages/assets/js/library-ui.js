import { getOpenListFileInfo } from "./openlist-client.js?v=20261112-four-source-login1";
import { parseSynchronizedLyrics } from "./player-effects.js?v=20261111-sylt-ms1";

const PERIODS = [["week","近 7 日"],["month","近 30 日"],["year","近 365 日"],["all","全部時間"]];
const PLAYBACK_QUEUE_STORAGE_KEY = "frame-audio-playback-queue-v1";
const PLAYBACK_POSITION_STORAGE_KEY = "frame-audio-playback-position-v1";
const USER_PLAYLISTS_STORAGE_KEY = "frame-audio-user-playlists-v1";
const FAVORITES_PLAYLIST_ID = "favorites";

export function initLibraryUI(options = {}) {
  const root = document.querySelector("#library-content");
  const audio = document.querySelector("#audio-player");
  const $ = selector => document.querySelector(selector);
  const defaultDocumentTitle = document.title || "FRAME Audio";
  let lastMediaPositionUpdate = 0;
  let mediaMetadataItemKey = "";
  let mediaSessionArtworkRequestId = 0;
  let mediaSessionArtworkPendingKey = "";
  let activeAudioTimingCleanup = null;
  let playbackNoticeTimer = 0;
  let activePlaybackProviderLabel = "VPS Alist";
  const playbackLogEntries = [];
  let mediaSessionArtworkObjectUrl = "";
  let mediaSessionArtworkObjectUrlKey = "";
  const state = {
    view:"music",lastLibraryView:"music",tracks:[],folders:[],shows:[],episodes:[],recentTracks:[],playlists:[],selectedFolder:null,selectedPlaylistId:"",playlistDialogItem:null,loaded:false,loadedAt:0,busy:false,trackPage:0,
    selectedShowId:"",selectedAlbum:null,search:"",searchComposing:false,items:[],itemType:"track",reportPeriod:"week",reportType:"episode",
    errors:[],currentItem:null,queue:[],queueIndex:-1,queueLabel:"播放列表",session:null,tickAt:0,speed:1,
    lastProgressSave:0,restorePositionMs:0,playRequestId:0,artworkUrls:new Set(),
    preloadEntry:null,preloadAudio:null,preloadGeneration:0,restoredPlaybackPending:false,lastLocalPositionSaveAt:0,
    playMode:"sequential",shuffleEnabled:false,shuffleOrder:[],shufflePosition:-1,
    lyricsCues:[],lyricsPlainLines:[],lyricsActiveIndex:-1,
    lyricsScrollPause:new WeakMap()
  };
  const PLAY_MODES=["sequential","repeat-one","repeat-all"];
  const TRACKS_PAGE_SIZE=200;
  const QUEUE_ROW_HEIGHT_DESKTOP=58;
  const QUEUE_ROW_HEIGHT_MOBILE=54;
  const QUEUE_OVERSCAN=8;
  let queueRenderFrame=0;
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
  function playbackProviderLabel(provider) {
    return ({vps:"VPS Alist",worker:"OpenList Worker","mobile-device":"Mobile Device Alist",local:"區域網路 OpenList"})[String(provider||"vps")] || "OpenList";
  }
  function appendPlaybackLog(message, level="info") {
    const now=new Date();
    const stamp=[String(now.getHours()).padStart(2,"0"),String(now.getMinutes()).padStart(2,"0"),String(now.getSeconds()).padStart(2,"0")].join(":")+"."+String(now.getMilliseconds()).padStart(3,"0");
    const line=stamp+"  "+String(message||"");
    playbackLogEntries.push(line);
    if(playbackLogEntries.length>200)playbackLogEntries.shift();
    const output=$("#playback-log-output");
    if(output){
      const placeholder=output.querySelector(".playback-log-placeholder");
      if(placeholder)placeholder.remove();
      const row=document.createElement("div");
      row.className="playback-log-line";
      row.dataset.level=["success","warning","error"].includes(level)?level:"info";
      row.textContent=line;
      output.append(row);
      while(output.children.length>200)output.firstElementChild.remove();
      output.scrollTop=output.scrollHeight;
    }
    const count=$("#playback-log-count");
    if(count)count.textContent=playbackLogEntries.length+" 筆";
    if(level==="error"){
      const panel=$("#playback-log-panel");
      if(panel)panel.open=true;
    }
  }
  function hidePlaybackConnectionStatus(requestId=state.playRequestId) {
    if(requestId!==state.playRequestId)return;
    const node=$("#playback-connection-notice");
    if(!node)return;
    window.clearTimeout(playbackNoticeTimer);
    node.classList.remove("is-visible");
    playbackNoticeTimer=window.setTimeout(()=>{
      if(requestId===state.playRequestId&&!node.classList.contains("is-visible"))node.hidden=true;
    },260);
  }
  function setPlaybackConnectionStatus(message,type="connecting",requestId=state.playRequestId,hideAfterMs=0) {
    if(requestId!==state.playRequestId)return;
    const node=$("#playback-connection-notice");
    if(!node)return;
    window.clearTimeout(playbackNoticeTimer);
    node.textContent=String(message||"");
    node.className="playback-connection-notice is-visible"+(type?" is-"+type:"");
    node.hidden=false;
    if(hideAfterMs>0)playbackNoticeTimer=window.setTimeout(()=>hidePlaybackConnectionStatus(requestId),hideAfterMs);
  }
  const mediaReadyStateName=value=>["HAVE_NOTHING","HAVE_METADATA","HAVE_CURRENT_DATA","HAVE_FUTURE_DATA","HAVE_ENOUGH_DATA"][Number(value)]||"UNKNOWN";
  const mediaNetworkStateName=value=>["NETWORK_EMPTY","NETWORK_IDLE","NETWORK_LOADING","NETWORK_NO_SOURCE"][Number(value)]||"UNKNOWN";
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

  function attachAudioStartupTiming(media, startedAt, context = {}) {
    const timings = {};
    const listeners = [];
    let timeoutId = 0;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (const [eventName, handler] of listeners) media.removeEventListener(eventName, handler);
      if (timeoutId) clearTimeout(timeoutId);
      if (activeAudioTimingCleanup === cleanup) activeAudioTimingCleanup = null;
    };
    const eventDetail = eventName => {
      const elapsed=Math.round(performance.now()-startedAt);
      const extra=eventName==="loadedmetadata"&&Number.isFinite(media.duration)
        ? "；時長 "+duration(media.duration*1000)
        : "";
      return "HTML5 Audio "+eventName+" · "+elapsed+" ms"+extra+
        " · readyState="+media.readyState+" ("+mediaReadyStateName(media.readyState)+")"+
        " · networkState="+media.networkState+" ("+mediaNetworkStateName(media.networkState)+")";
    };
    const mark = (eventName, key) => {
      const handler = () => {
        if (timings[key] === undefined) timings[key] = Math.round(performance.now() - startedAt);
        appendPlaybackLog(eventDetail(eventName),eventName==="playing"?"success":"info");
        if (eventName === "playing") {
          console.info("[FRAME Audio] Audio startup pipeline", {
            ...context,
            ...timings,
            totalToPlayingMs: timings.playingMs
          });
          setPlaybackConnectionStatus("已開始播放 · "+(context.providerLabel||"OpenList"),"success",context.requestId,2200);
          cleanup();
        }
      };
      media.addEventListener(eventName, handler);
      listeners.push([eventName, handler]);
    };
    mark("play", "playEventMs");
    mark("loadstart", "loadStartMs");
    mark("loadedmetadata", "loadedMetadataMs");
    mark("loadeddata", "loadedDataMs");
    mark("canplay", "canPlayMs");
    mark("playing", "playingMs");
    const onWaiting = () => {
      appendPlaybackLog(eventDetail("waiting"),"warning");
      setPlaybackConnectionStatus("音訊串流暫時等待資料…","warning",context.requestId);
    };
    const onStalled = () => {
      appendPlaybackLog(eventDetail("stalled"),"warning");
      setPlaybackConnectionStatus("音訊來源暫時沒有傳送資料…","warning",context.requestId);
    };
    media.addEventListener("waiting",onWaiting);
    media.addEventListener("stalled",onStalled);
    listeners.push(["waiting",onWaiting],["stalled",onStalled]);
    const onError = () => {
      const errorCode=media.error?.code||null;
      const errorMessage=media.error?.message||"瀏覽器未提供更詳細的 MediaError 訊息";
      appendPlaybackLog("HTML5 Audio error · MediaError code="+String(errorCode||"未知")+" · "+errorMessage+
        " · readyState="+media.readyState+" · networkState="+media.networkState,"error");
      setPlaybackConnectionStatus("音訊載入失敗 · MediaError "+String(errorCode||"未知"),"error",context.requestId,10000);
      console.warn("[FRAME Audio] Audio startup pipeline failed", {
        ...context,
        ...timings,
        errorCode,
        errorMessage
      });
      cleanup();
    };
    media.addEventListener("error", onError);
    listeners.push(["error", onError]);
    timeoutId = setTimeout(()=>{
      if(cleaned)return;
      appendPlaybackLog("播放啟動等待超過 60 秒，尚未收到 playing 事件。","warning");
      setPlaybackConnectionStatus("尚未開始播放，請查看頁面最底部的連線日誌。","warning",context.requestId,10000);
      cleanup();
    },60000);
    return cleanup;
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
    const preloadStartedAt = performance.now();
    const entry = {
      itemId: item.id,
      path: pathOf(item),
      itemType: state.currentItem.itemType,
      generation,
      startedAt: preloadStartedAt,
      fileInfoMs: null,
      bufferReady: false,
      info: null,
      audio: null,
      promise: null
    };
    state.preloadEntry = entry;
    console.info("[FRAME Audio] Next-track preload started", { remainingSeconds: Math.max(0, Math.round(durationSeconds - audio.currentTime)) });

    entry.promise = getOpenListFileInfo({
      baseUrl: config.baseUrl,
      path: entry.path,
      timeoutMs: 180000
    }).then(info => {
      if (state.preloadEntry !== entry || state.preloadGeneration !== generation) return null;
      if (!info || info.is_dir || !info.raw_url) throw new Error("下一首音訊沒有有效的播放網址。");
      entry.info = info;
      entry.fileInfoMs = Math.round(performance.now() - preloadStartedAt);

      const warmedAudio = new Audio();
      warmedAudio.preload = "auto";
      for (const [eventName, milestone] of [["loadedmetadata", "metadata"], ["loadeddata", "data"], ["canplay", "canplay"]]) {
        warmedAudio.addEventListener(eventName, () => {
          if (state.preloadEntry !== entry) return;
          if (milestone === "canplay") entry.bufferReady = true;
          console.info("[FRAME Audio] Next-track buffer", {
            milestone,
            fileInfoMs: entry.fileInfoMs,
            elapsedMs: Math.round(performance.now() - preloadStartedAt),
            readyState: warmedAudio.readyState,
            bufferReady: entry.bufferReady
          });
        }, { once: true });
      }
      warmedAudio.addEventListener("stalled", () => {
        if (state.preloadEntry === entry) {
          console.warn("[FRAME Audio] Next-track buffer stalled", {
            elapsedMs: Math.round(performance.now() - preloadStartedAt),
            readyState: warmedAudio.readyState
          });
        }
      }, { once: true });
      warmedAudio.addEventListener("error", () => {
        if (state.preloadEntry === entry) {
          console.warn("[FRAME Audio] Next-track buffer failed", {
            fileInfoMs: entry.fileInfoMs,
            errorCode: warmedAudio.error?.code || null
          });
        }
      }, { once: true });
      warmedAudio.src = info.raw_url;
      entry.audio = warmedAudio;
      state.preloadAudio = warmedAudio;
      try { warmedAudio.load(); } catch {}
      console.info("[FRAME Audio] Next-track file info ready", {
        fileInfoMs: entry.fileInfoMs,
        sizeBytes: Number(info.size || 0),
        warmedAudio: true,
        transport: "direct-raw-url"
      });
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
    bindLyricsManualScroll(list);
    syncLyricsHighlight({forceScroll:true});
  }
  function animatePlayerControlMove(element, direction) {
    if (!element || typeof element.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const entering = direction !== "return";
    const frames = entering
      ? [
          { opacity: 0, transform: "translate3d(0,14px,0) scale(.95)", filter: "blur(3px)" },
          { opacity: 1, transform: "translate3d(0,0,0) scale(1)", filter: "blur(0)" }
        ]
      : [
          { opacity: 0, transform: "translate3d(0,10px,0) scale(.97)", filter: "blur(2px)" },
          { opacity: 1, transform: "translate3d(0,0,0) scale(1)", filter: "blur(0)" }
        ];
    try {
      element.animate(frames, {
        duration: entering ? 460 : 380,
        easing: "cubic-bezier(.2,.78,.22,1)",
        fill: "none"
      });
    } catch {}
  }

  function renderNowPlaying() {
    let page=document.querySelector(".now-playing-page");
    if(page?.dataset.closing==="true")return;
    const item=state.currentItem;
    // Keep the original, event-bound controls alive while rebuilding the detail view.
    const transport=$("#player-transport");
    const detailControls=$("#player-detail-controls");
    const transportStartsInDock=transport?.parentElement?.classList.contains("dock-transport-host");
    const controlsStartInDock=detailControls?.parentElement?.classList.contains("dock");
    if(!page){
      page=document.createElement("section");
      page.className="now-playing-page now-playing-enter";
      page.setAttribute("aria-label","正在播放");
      page.addEventListener("animationend",event=>{
        if(event.target===page&&event.animationName==="now-playing-slide-up")page.classList.remove("now-playing-enter");
      });
      // The overlay lives outside the library DOM, so delegate its controls here.
      page.addEventListener("click",handleClick);
      document.body.append(page);
    }
    const pendingNotice=root.querySelector(":scope > .now-playing-notice");
    if(pendingNotice)page.prepend(pendingNotice);
    if(!item){
      page.innerHTML='<div class="now-playing-empty"><button class="secondary" data-action="back-now-playing">⌄ 收起播放器</button><h2>尚未播放音訊</h2><p>從 Music 或 Podcast 選擇內容後，這裡會顯示目前歌曲與同步歌詞。</p></div>';
      const dockTransport=document.querySelector(".dock-transport-host"),dock=document.querySelector(".dock");
      if(transport&&dockTransport)restoreDockTransportToDock(transport,dockTransport);
      if(detailControls&&dock)dock.append(detailControls);
      return;
    }
    const parsed=currentLyrics(),kind=item.itemType==="episode"?"PODCAST":"MUSIC";
    const artist=item.subtitle||item.albumArtist||item.album||"";
    page.innerHTML='<div class="now-playing-topbar">'+
      '<button class="now-playing-back" data-action="back-now-playing" type="button" aria-label="收起正在播放詳情"><span aria-hidden="true">⌄</span><small>收起</small></button>'+
      '<div class="now-playing-topbar-copy"><span class="kicker">NOW PLAYING</span><strong>正在播放</strong></div>'+
      '<span class="now-playing-kind">'+kind+'</span></div>'+
      '<div class="now-playing-main">'+
       '<div class="now-playing-track">'+
        '<div class="now-playing-art" id="now-playing-art"><span>'+esc(String(item.title||"FA").slice(0,1).toUpperCase())+'</span></div>'+
        '<div class="now-playing-track-copy"><span class="kicker">CURRENT TRACK</span><h1>'+esc(item.title||"未命名音訊")+'</h1><p>'+esc(artist)+'</p><div class="now-playing-track-meta"><span>'+kind+'</span><span>'+duration(item.durationMs)+'</span></div></div>'+
        '<div class="now-playing-playback-panel"><div class="now-playing-transport-host"></div><div class="now-playing-tools-host"></div></div>'+
        (item.itemType==="track"&&pathOf(item)&&typeof options.reindexMusic==="function"?'<button class="secondary now-playing-reindex" data-action="reindex-current-lyrics">重新讀取這首歌的標籤</button>':"")+
        '<p class="now-playing-reindex-status" id="now-playing-reindex-status" role="status"></p></div>'+
       '<section class="now-playing-lyrics-panel" aria-label="同步歌詞"><div class="now-playing-lyrics-heading"><span class="kicker">LYRICS</span><span>'+(parsed.cues.length?parsed.cues.length+" 個時間點":parsed.plainLines.length?"純文字歌詞":"尚無歌詞")+'</span></div>'+
        '<div class="now-playing-lyrics-list" id="now-playing-lyrics-list" aria-live="polite">'+lyricsMarkup(parsed,"now-playing-lyric-line")+'</div></section>'+
      '</div>';
    const transportHost=page.querySelector(".now-playing-transport-host");
    const controlsHost=page.querySelector(".now-playing-tools-host");
    if(transport&&transportHost){
      if(transportStartsInDock)reserveDockTransportSlot(transport);
      transportHost.append(transport);
      if(transportStartsInDock)animatePlayerControlMove(transport,"enter");
    }
    if(detailControls&&controlsHost){
      controlsHost.append(detailControls);
      if(controlsStartInDock)animatePlayerControlMove(detailControls,"enter");
    }
    bindLyricsManualScroll($("#now-playing-lyrics-list"));
    syncNowPlayingArtwork(item);syncLyricsHighlight({forceScroll:true});
  }
  function closeNowPlaying() {
    if(state.view!=="now-playing")return;
    const page=document.querySelector(".now-playing-page");
    if(!page){void showView(state.lastLibraryView||"music");return;}
    if(page.dataset.closing==="true")return;

    page.dataset.closing="true";
    const currentStyle=getComputedStyle(page);
    const startTransform=currentStyle.transform==="none"?"translate3d(0,0,0)":currentStyle.transform;
    const startOpacity=currentStyle.opacity||"1";
    let finished=false;
    let fallbackTimer=0;
    const finish=()=>{
      if(finished)return;
      finished=true;
      if(fallbackTimer)clearTimeout(fallbackTimer);
      if(state.view==="now-playing")void showView(state.lastLibraryView||"music");
    };

    if(typeof page.animate==="function"){
      page.classList.remove("now-playing-enter");
      const exit=page.animate(
        [{transform:startTransform,opacity:startOpacity},{transform:"translate3d(0,100%,0)",opacity:"0.96"}],
        {duration:660,easing:"cubic-bezier(.55,.06,.68,.19)",fill:"forwards"}
      );
      exit.addEventListener("finish",finish,{once:true});
      fallbackTimer=setTimeout(finish,900);
      return;
    }

    page.classList.remove("now-playing-enter");
    void page.offsetWidth;
    page.classList.add("now-playing-exit");
    page.addEventListener("animationend",event=>{
      if(event.target===page&&event.animationName==="now-playing-slide-down")finish();
    },{once:true});
    fallbackTimer=setTimeout(finish,900);
  }
  function syncNowPlayingArtwork(item) {
    const host=$("#now-playing-art");if(!host||!item?.artworkHash)return;
    fetch("/api/artwork/"+item.artworkHash,{credentials:"same-origin"}).then(response=>response.ok?response.blob():null).then(blob=>{
      if(!blob||state.currentItem?.id!==item.id||state.view!=="now-playing")return;
      const url=URL.createObjectURL(blob);state.artworkUrls.add(url);host.style.backgroundImage="url('"+url+"')";host.classList.add("has-artwork");
      const fallback=host.querySelector("span");if(fallback)fallback.hidden=true;
    }).catch(()=>{});
  }
  function bindLyricsManualScroll(list) {
    if(!list||list.dataset.autoFollowBound==="true")return;
    list.dataset.autoFollowBound="true";
    const pauseAutoFollow=()=>{
      const previous=state.lyricsScrollPause.get(list);
      if(previous?.timer)clearTimeout(previous.timer);
      const timer=setTimeout(()=>{
        state.lyricsScrollPause.delete(list);
        if(list.isConnected)syncLyricsHighlight({forceScroll:true,list});
      },5000);
      state.lyricsScrollPause.set(list,{timer,until:Date.now()+5000});
    };
    const pointerMove=event=>{if(event.buttons>0)pauseAutoFollow();};
    list.addEventListener("wheel",pauseAutoFollow,{passive:true});
    list.addEventListener("touchstart",pauseAutoFollow,{passive:true});
    list.addEventListener("touchmove",pauseAutoFollow,{passive:true});
    list.addEventListener("pointerdown",pauseAutoFollow,{passive:true});
    list.addEventListener("pointermove",pointerMove,{passive:true});
    list.addEventListener("keydown",pauseAutoFollow);
  }
  function scrollLyricIntoList(list,line) {
    if(!list||!line)return;
    const listRect=list.getBoundingClientRect();
    const lineRect=line.getBoundingClientRect();
    const targetTop=list.scrollTop+lineRect.top-listRect.top-(list.clientHeight-lineRect.height)/2;
    list.scrollTo({top:Math.max(0,targetTop),behavior:"smooth"});
  }
  function syncLyricsHighlight(options={}) {
    if((state.view!=="now-playing"&&!$("#lyrics-dialog")?.open)||!state.lyricsCues.length)return;
    const time=Number(audio.currentTime||0);let low=0,high=state.lyricsCues.length-1,active=-1;
    while(low<=high){const mid=(low+high)>>1;if(state.lyricsCues[mid].time<=time){active=mid;low=mid+1;}else high=mid-1;}
    const activeChanged=active!==state.lyricsActiveIndex;
    state.lyricsActiveIndex=active;
    const lists=[];
    if(state.view==="now-playing")lists.push($("#now-playing-lyrics-list"));
    if($("#lyrics-dialog")?.open)lists.push($("#lyrics-list"));
    for(const list of [...new Set(lists.filter(Boolean))]){
      list.querySelectorAll("[data-lyric-index]").forEach((node,index)=>node.classList.toggle("active",index===active));
      const current=active>=0?list.querySelector('[data-lyric-index="'+active+'"]'):null;
      if(!current)continue;
      const pause=state.lyricsScrollPause.get(list);
      const manuallyPaused=Number(pause?.until||0)>Date.now();
      const forced=options.forceScroll===true&&(!options.list||options.list===list);
      if(forced||(activeChanged&&!manuallyPaused))scrollLyricIntoList(list,current);
    }
  }
  root.addEventListener("animationend",event=>{
    if(event.target===root&&event.animationName==="library-arrive"){
      root.classList.remove("view-enter");
    }
    if(event.animationName==="detail-arrive"&&event.target instanceof HTMLElement){
      event.target.style.willChange="auto";
    }
  });
  function animateLibraryContent(){
    root.classList.remove("view-enter");
    if(state.view==="now-playing")return;
    void root.offsetWidth;
    root.classList.add("view-enter");
  }
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
  function message(text,type=""){
    if(state.view==="now-playing"){
      const page=document.querySelector(".now-playing-page");
      const host=page||root;
      let notice=host.querySelector(".now-playing-notice");
      if(!notice){
        notice=document.createElement("div");
        notice.className="library-message now-playing-notice";
        host.prepend(notice);
      }
      notice.className="library-message now-playing-notice"+(type?" is-"+type:"");
      notice.textContent=String(text||"");
      return;
    }
    root.innerHTML='<div class="library-message '+(type?"is-"+type:"")+'">'+esc(text)+'</div>';
  }
  async function load(force=false) {
    if(state.busy)return;
    if(!force&&state.loaded&&Date.now()-state.loadedAt<30000){render();return;}
    state.busy=true;message("正在讀取 Music 與 Podcast 曲庫……");
    try {
      const [tracks,folders,shows,episodes,recentResult]=await Promise.all([
        all("/api/catalog?kind=tracks"),all("/api/catalog?kind=folders"),
        all("/api/catalog/podcasts?kind=shows"),all("/api/catalog/podcasts?kind=episodes"),
        api("/api/listening?view=recent&itemType=track&limit=8").catch(()=>({items:[]}))
      ]);
      Object.assign(state,{tracks,folders,shows,episodes,loaded:true,loadedAt:Date.now()});
      const tracksById=new Map(tracks.map(item=>[String(item.id||""),item]).filter(([id])=>id));
      const tracksByPath=new Map(tracks.map(item=>[String(pathOf(item)||""),item]).filter(([path])=>path));
      state.recentTracks=(recentResult.items||[]).map(record=>{
        const item=tracksById.get(String(record.item_id||""))||tracksByPath.get(String(record.path||""));
        return item?{...item,recentlyPlayedAt:record.updated_at}:{...record,id:record.item_id,path:record.path,recentlyPlayedAt:record.updated_at};
      });
      restoreSavedPlaybackState();
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
  function playbackItemRef(item) {
    return [String(item?.id||item?.item_id||""),String(pathOf(item)||"")];
  }
  function displayFolderName(value) {
    const raw=String(value||"").trim();
    return raw.replace(/^\d{2}\s+/u,"").trim()||raw;
  }
  function loadUserPlaylists() {
    let saved=[];try{const parsed=JSON.parse(localStorage.getItem(USER_PLAYLISTS_STORAGE_KEY)||"[]");if(Array.isArray(parsed))saved=parsed;}catch{}
    const cleanRefs=entry=>Array.isArray(entry?.items)?entry.items.map(ref=>({id:String(ref?.id||""),path:String(ref?.path||"")})).filter(ref=>ref.id||ref.path):[];
    const favorites=saved.find(entry=>entry&&entry.id===FAVORITES_PLAYLIST_ID);
    const custom=saved.filter(entry=>entry&&typeof entry==="object"&&String(entry.id||"")!==FAVORITES_PLAYLIST_ID)
      .map(entry=>({id:String(entry.id||"").slice(0,100),name:String(entry.name||"未命名歌單").trim().slice(0,40)||"未命名歌單",items:cleanRefs(entry)})).filter(entry=>entry.id);
    state.playlists=[{id:FAVORITES_PLAYLIST_ID,name:"收藏夾",builtIn:true,items:cleanRefs(favorites)},...custom];
  }
  function saveUserPlaylists() {
    try{localStorage.setItem(USER_PLAYLISTS_STORAGE_KEY,JSON.stringify(state.playlists.map(entry=>({id:entry.id,name:entry.name,items:entry.items}))));return true;}
    catch{message("歌單無法保存，可能是此瀏覽器的本機儲存空間已滿。","error");return false;}
  }
  function findPlaylist(id){return state.playlists.find(entry=>entry.id===String(id||""))||null;}
  function playlistContainsItem(playlist,item){
    const [id,path]=playbackItemRef(item);
    return playlist.items.some(ref=>(id&&String(ref.id||"")===id)||(path&&String(ref.path||"")===path));
  }
  function togglePlaylistItem(playlist,item,forceAdd=null){
    if(!playlist||!item)return false;
    const [id,path]=playbackItemRef(item);if(!id&&!path)return false;
    const exists=playlistContainsItem(playlist,item),shouldAdd=forceAdd===null?!exists:forceAdd===true;
    if(shouldAdd&&!exists)playlist.items.push({id,path});
    if(!shouldAdd&&exists)playlist.items=playlist.items.filter(ref=>!((id&&String(ref.id||"")===id)||(path&&String(ref.path||"")===path)));
    saveUserPlaylists();return shouldAdd;
  }
  function createUserPlaylist(name){
    const clean=String(name||"").trim().slice(0,40);if(!clean)throw new Error("請先輸入歌單名稱。");
    if(state.playlists.some(entry=>entry.name.toLocaleLowerCase()===clean.toLocaleLowerCase()))throw new Error("已經有同名歌單，請換一個名稱。");
    const id="playlist-"+(window.crypto?.randomUUID?.()||Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,9));
    const playlist={id,name:clean,items:[]};state.playlists.push(playlist);saveUserPlaylists();return playlist;
  }
  function resolvePlaylistTracks(playlist){
    if(!playlist)return [];
    const byId=new Map(state.tracks.map(item=>[String(item.id||""),item]).filter(([id])=>id));
    const byPath=new Map(state.tracks.map(item=>[String(pathOf(item)||""),item]).filter(([path])=>path));
    const result=[],seen=new Set();
    for(const ref of playlist.items){const item=(ref.id&&byId.get(String(ref.id)))||(ref.path&&byPath.get(String(ref.path)));if(!item)continue;
      const key=String(item.id||pathOf(item));if(seen.has(key))continue;seen.add(key);result.push(item);}
    return result;
  }
  function openPlaylistDialog(item=null){
    const dialog=$("#playlist-picker-dialog");if(!dialog){message("歌單視窗尚未載入，請重新整理頁面。","error");return;}
    state.playlistDialogItem=item||null;
    const title=$("#playlist-picker-title"),track=$("#playlist-picker-track"),list=$("#playlist-picker-list"),input=$("#playlist-new-name"),status=$("#playlist-dialog-status");
    if(title)title.textContent=item?"加入收藏歌單":"建立新歌單";
    if(track){track.hidden=!item;track.textContent=item?"加入歌曲："+String(item.title||pathOf(item).split("/").pop()||"未命名音訊"):"";}
    if(list)list.hidden=!item;if(input)input.value="";
    if(status)status.textContent=item?"選擇一個歌單即可加入或移除這首歌曲。":"建立後，歌單會出現在「收藏歌單」列表中。";
    renderPlaylistPicker();openModal(dialog);window.setTimeout(()=>input?.focus(),40);
  }
  function renderPlaylistPicker(){
    const list=$("#playlist-picker-list");if(!list)return;if(!state.playlistDialogItem){list.replaceChildren();return;}
    list.innerHTML=state.playlists.map(playlist=>{
      const included=playlistContainsItem(playlist,state.playlistDialogItem);
      return '<button type="button" class="playlist-picker-option" data-action="toggle-playlist-membership" data-playlist-id="'+esc(playlist.id)+'" aria-pressed="'+String(included)+'">'+
        '<span class="playlist-picker-icon">'+(playlist.id===FAVORITES_PLAYLIST_ID?"♡":"♫")+'</span>'+
        '<span class="playlist-picker-copy"><strong>'+esc(playlist.name)+'</strong><small>'+playlist.items.length.toLocaleString()+' 首'+(included?" · 已加入，點擊可移除":" · 點擊加入")+'</small></span>'+
        '<span class="playlist-picker-check">'+(included?"✓":"＋")+'</span></button>';
    }).join("");
  }
  function folderTracks(folder){
    const trimSlash=value=>String(value||"").replace(new RegExp("/+$"),"");
    const directory=trimSlash(folder?.path);if(!directory)return [];
    return state.tracks.filter(track=>{const path=trimSlash(pathOf(track));return path===directory||path.startsWith(directory+"/");})
      .sort((a,b)=>String(pathOf(a)||"").localeCompare(String(pathOf(b)||""),"zh-Hant"));
  }
  function syncActiveNavigation(){
    let active=state.view;
    if(state.view==="now-playing")active=state.currentItem?.itemType==="episode"?"podcasts":"music";
    else if(["shows","show-detail","continue"].includes(state.view))active="podcasts";
    else if(state.view==="music"&&state.currentItem?.itemType==="episode")active="podcasts";
    else if(state.view==="album-detail")active="albums";
    document.querySelectorAll("#site-sidebar [data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===active));
  }
  function reserveDockTransportSlot(transport){
    const host=transport?.parentElement;if(!host?.classList.contains("dock-transport-host")||host.querySelector(".dock-transport-placeholder"))return;
    const placeholder=document.createElement("div");placeholder.className="dock-transport-placeholder";placeholder.setAttribute("aria-hidden","true");host.insertBefore(placeholder,transport);
  }
  function restoreDockTransportToDock(transport,host){
    if(!transport||!host)return;const placeholder=host.querySelector(".dock-transport-placeholder");
    if(placeholder)placeholder.replaceWith(transport);else host.append(transport);
  }
  function defaultQueueLabel(type,item) {
    if(type==="episode"){
      const show=state.shows.find(entry=>String(entry.id)===String(item?.showId||""));
      return "Podcast / "+String(item?.showTitle||show?.title||item?.subtitle||"節目");
    }
    if(state.view==="folders"&&state.selectedFolder)return "資料夾 / "+displayFolderName(state.selectedFolder.name||state.selectedFolder.path.split("/").filter(Boolean).pop()||"未命名資料夾");
    if(state.view==="playlists"&&state.selectedPlaylistId){const playlist=findPlaylist(state.selectedPlaylistId);if(playlist)return playlist.id===FAVORITES_PLAYLIST_ID?"收藏夾":"歌單 / "+playlist.name;}
    if(state.view==="album-detail"&&state.selectedAlbum){
      const album=state.selectedAlbum;
      return "專輯 / "+String(album.title||"未命名專輯")+(album.artist?"（"+album.artist+"）":"");
    }
    if(state.view==="show-detail"){
      const show=state.shows.find(entry=>String(entry.id)===String(state.selectedShowId));
      if(show)return "Podcast / "+String(show.title||"節目");
    }
    if(state.view==="tracks"){
      const query=String(state.search||"").trim();
      return query?"搜尋結果 / "+query:"所有歌曲";
    }
    if(state.view==="music")return "最近播放的音樂";
    return "所有歌曲";
  }
  function savePlaybackQueueState() {
    if(!state.currentItem||!state.queue.length||state.queueIndex<0||state.queueIndex>=state.queue.length)return;
    const payload={
      version:1,
      itemType:state.currentItem.itemType==="episode"?"episode":"track",
      queueLabel:String(state.queueLabel||"播放列表").slice(0,240),
      currentItem:playbackItemRef(state.currentItem),
      queue:state.queue.map(playbackItemRef),
      queueIndex:state.queueIndex,
      playMode:PLAY_MODES.includes(state.playMode)?state.playMode:"sequential",
      shuffleEnabled:state.shuffleEnabled===true,
      shuffleOrder:state.shuffleEnabled&&state.shuffleOrder.length===state.queue.length?[...state.shuffleOrder]:[],
      playbackRate:Number(state.speed)||1,
      savedAt:Date.now()
    };
    try{localStorage.setItem(PLAYBACK_QUEUE_STORAGE_KEY,JSON.stringify(payload));}
    catch(error){
      try{
        payload.queue=state.queue.map(item=>[String(item?.id||item?.item_id||""),""]);
        payload.shuffleOrder=[];
        localStorage.setItem(PLAYBACK_QUEUE_STORAGE_KEY,JSON.stringify(payload));
      }catch(storageError){console.warn("[FRAME Audio] Could not save playback queue locally",storageError||error);}
    }
  }
  function savePlaybackPosition(force=false,overridePositionMs=null) {
    if(!state.currentItem)return;
    const now=Date.now();
    if(!force&&now-state.lastLocalPositionSaveAt<5000)return;
    const hasOverride=overridePositionMs!==null&&overridePositionMs!==undefined&&Number.isFinite(Number(overridePositionMs));
    const position=hasOverride?Math.max(0,Number(overridePositionMs)):
      audio.src&&Number.isFinite(audio.currentTime)?Math.max(0,audio.currentTime*1000):Math.max(0,Number(state.restorePositionMs)||0);
    const payload={
      version:1,
      itemType:state.currentItem.itemType==="episode"?"episode":"track",
      itemId:String(state.currentItem.id||state.currentItem.item_id||""),
      path:String(pathOf(state.currentItem)||""),
      positionMs:Math.round(position),
      durationMs:Number.isFinite(audio.duration)?Math.round(audio.duration*1000):Number(state.currentItem.durationMs||0)||null,
      playbackRate:Number(state.speed)||1,
      savedAt:now
    };
    try{localStorage.setItem(PLAYBACK_POSITION_STORAGE_KEY,JSON.stringify(payload));state.lastLocalPositionSaveAt=now;}
    catch(error){console.warn("[FRAME Audio] Could not save playback position locally",error);}
  }
  function clearSavedPlaybackState() {
    try{localStorage.removeItem(PLAYBACK_QUEUE_STORAGE_KEY);localStorage.removeItem(PLAYBACK_POSITION_STORAGE_KEY);}catch{}
    state.restoredPlaybackPending=false;
  }
  function restoreSavedPlaybackState() {
    let saved;
    try{saved=JSON.parse(localStorage.getItem(PLAYBACK_QUEUE_STORAGE_KEY)||"null");}catch{return false;}
    if(!saved||saved.version!==1||!["track","episode"].includes(saved.itemType)||!Array.isArray(saved.queue)||!saved.queue.length)return false;
    const type=saved.itemType,catalog=type==="episode"?state.episodes:state.tracks;
    if(!catalog.length)return false;
    const byId=new Map(),byPath=new Map();
    for(const item of catalog){
      const id=String(item?.id||item?.item_id||""),path=String(pathOf(item)||"");
      if(id&&!byId.has(id))byId.set(id,item);
      if(path&&!byPath.has(path))byPath.set(path,item);
    }
    const showTitles=new Map(state.shows.map(show=>[String(show.id),String(show.title||"")]));
    const queue=[],oldToNew=new Map();
    saved.queue.forEach((entry,oldIndex)=>{
      const id=Array.isArray(entry)?String(entry[0]||""):String(entry?.id||"");
      const path=Array.isArray(entry)?String(entry[1]||""):String(entry?.path||"");
      const found=(id&&byId.get(id))||(path&&byPath.get(path));
      if(!found)return;
      const item=type==="episode"&&!found.showTitle?{...found,showTitle:showTitles.get(String(found.showId||""))||found.subtitle||"Podcast"}:{...found};
      oldToNew.set(oldIndex,queue.length);queue.push(item);
    });
    if(!queue.length)return false;
    let restoredIndex=oldToNew.get(Number(saved.queueIndex));
    if(restoredIndex==null){
      const ref=Array.isArray(saved.currentItem)?saved.currentItem:[saved.currentItem?.id,saved.currentItem?.path];
      const id=String(ref?.[0]||""),path=String(ref?.[1]||"");
      restoredIndex=queue.findIndex(item=>(id&&String(item.id||item.item_id||"")===id)||(path&&pathOf(item)===path));
    }
    if(!Number.isInteger(restoredIndex)||restoredIndex<0||restoredIndex>=queue.length)restoredIndex=0;
    state.queue=queue;state.queueIndex=restoredIndex;
    state.queueLabel=String(saved.queueLabel|| (type==="episode"?"Podcast":"所有歌曲")).slice(0,240);
    state.currentItem=playable(queue[restoredIndex],type);state.session=null;
    state.playMode=PLAY_MODES.includes(saved.playMode)?saved.playMode:state.playMode;
    state.shuffleEnabled=saved.shuffleEnabled===true;
    const mappedOrder=Array.isArray(saved.shuffleOrder)?saved.shuffleOrder.map(oldIndex=>oldToNew.get(Number(oldIndex))).filter(Number.isInteger):[];
    const validOrder=mappedOrder.length===queue.length&&new Set(mappedOrder).size===queue.length&&mappedOrder.every(index=>index>=0&&index<queue.length);
    if(state.shuffleEnabled&&validOrder){state.shuffleOrder=mappedOrder;state.shufflePosition=state.shuffleOrder.indexOf(state.queueIndex);}
    else rebuildShuffleOrder(state.queueIndex);
    const rate=Number(saved.playbackRate);
    state.speed=Number.isFinite(rate)?Math.min(2,Math.max(.5,rate)):1;
    const speedSelect=$("#player-speed");if(speedSelect)speedSelect.value=String(state.speed);
    let position=null;
    try{position=JSON.parse(localStorage.getItem(PLAYBACK_POSITION_STORAGE_KEY)||"null");}catch{}
    const positionMatches=position&&position.version===1&&position.itemType===type&&
      ((String(position.itemId||"")&&String(position.itemId)===String(state.currentItem.id||state.currentItem.item_id||""))||
       (String(position.path||"")&&String(position.path)===pathOf(state.currentItem)));
    state.restorePositionMs=positionMatches&&Number.isFinite(Number(position.positionMs))?Math.max(0,Number(position.positionMs)):0;
    if(positionMatches&&Number.isFinite(Number(position.playbackRate))){
      state.speed=Math.min(2,Math.max(.5,Number(position.playbackRate)));
      if(speedSelect)speedSelect.value=String(state.speed);
    }
    state.restoredPlaybackPending=true;state.lastLocalPositionSaveAt=0;
    updatePlayerModeButton();updateShuffleButton();setDock(state.currentItem);
    $("#player-type").textContent=(type==="episode"?"PODCAST":"MUSIC")+" · 已恢復";
    $("#player-toggle").textContent="▶";
    appendPlaybackLog("已恢復上次播放清單 · "+queue.length.toLocaleString()+" 首 · 目前第 "+(state.queueIndex+1).toLocaleString()+" 首；按播放即可繼續。");
    return true;
  }
  function sectionHead(kicker,title,tail=""){return '<div class="library-section-head"><div><span class="kicker">'+esc(kicker)+'</span><h3>'+esc(title)+'</h3></div>'+tail+'</div>';}
  function stats(cards){return '<div class="summary-grid">'+cards.map(c=>'<div class="summary-card"><span>'+esc(c[0])+'</span><strong>'+esc(c[1])+'</strong></div>').join("")+'</div>';}
  function searchBar(placeholder) {
    return '<div class="library-toolbar"><input id="library-search" class="library-search" type="search" placeholder="'+esc(placeholder)+'" value="'+esc(state.search)+'">'+
      '<span class="library-muted">'+state.tracks.length.toLocaleString()+' 首音樂 · '+state.shows.length.toLocaleString()+' 個節目 · '+state.episodes.length.toLocaleString()+' 集單集</span></div>';
  }
  function trackRows(rows,type="track",queueRows=rows,indexOffset=0,rowOptions={}) {
    state.items=queueRows;state.itemType=type;
    if(!rows.length)return '<div class="library-empty"><div class="library-empty-mark">♫</div><h3>目前沒有項目</h3><p>完成索引後，內容就會出現在這裡。</p></div>';
    return '<div class="media-list">'+rows.map((raw,i)=>{
      const item=playable(raw,type),itemIndex=indexOffset+i;
      const rowAction=type==="track"?' data-action="play" data-index="'+itemIndex+'"':"";
      const add=type==="track"?'<button class="playlist-add-button" type="button" data-action="open-playlist-picker" data-index="'+itemIndex+'" aria-label="加入收藏歌單" title="加入收藏歌單">＋</button>':"";
      const remove=rowOptions.removeFromPlaylist?'<button class="playlist-remove-button" type="button" data-action="remove-from-playlist" data-index="'+itemIndex+'" aria-label="從歌單移除" title="從這份歌單移除">−</button>':"";
      return '<article class="media-row"'+rowAction+'>'+cover(item.artworkHash,item.title)+
        '<div class="media-copy"><strong title="'+esc(item.title)+'">'+esc(item.title)+'</strong><span>'+esc(item.subtitle||item.path)+'</span>'+
        (type==="track"&&item.album?'<button class="album-link" type="button" data-action="open-track-album" data-index="'+itemIndex+'" title="開啟專輯">'+esc(item.album)+'</button>':"")+
        '</div><span class="media-duration">'+duration(item.durationMs)+'</span><div class="media-row-actions">'+add+remove+'<button class="play-button" type="button" data-action="play" data-index="'+itemIndex+'" aria-label="播放" title="播放">▶</button></div></article>';
    }).join("")+'</div>';
  }
  function renderHome() {
    const recent=state.recentTracks.slice(0,8);
    const recentMarkup=recent.length?trackRows(recent,"track"):
      '<div class="library-empty"><div class="library-empty-mark">♫</div><h3>還沒有播放紀錄</h3><p>開始播放音樂後，最近播放的歌曲就會出現在這裡。</p></div>';
    if(!recent.length){state.items=[];state.itemType="track";}
    root.innerHTML=stats([["MUSIC TRACKS",state.tracks.length.toLocaleString()],["PODCAST SHOWS",state.shows.length.toLocaleString()],["PODCAST EPISODES",state.episodes.length.toLocaleString()]])+
      sectionHead("RECENTLY PLAYED","最近播放的音樂",'<button class="secondary" data-action="navigate" data-view="tracks">查看全部歌曲</button>')+
      recentMarkup+
      sectionHead("PODCASTS","你的節目",'<button class="secondary" data-action="navigate" data-view="shows">查看全部</button>')+
      showCards(state.shows.slice(0,6));
    loadCovers();
  }
  function renderTracks() {
    const q=state.search.toLocaleLowerCase();
    const rows=state.tracks.filter(t=>!q||[t.title,t.album,t.albumArtist,t.file?.path,...(t.artists||[]),...(t.genres||[])].join(" ").toLocaleLowerCase().includes(q));
    const pageCount=Math.max(1,Math.ceil(rows.length/TRACKS_PAGE_SIZE));
    state.trackPage=Math.max(0,Math.min(pageCount-1,Number(state.trackPage)||0));
    const page=state.trackPage,start=page*TRACKS_PAGE_SIZE;
    const visibleRows=rows.slice(start,start+TRACKS_PAGE_SIZE);
    const pageControls=rows.length>TRACKS_PAGE_SIZE
      ?'<nav class="library-pagination" aria-label="歌曲分頁">'+
        '<button class="secondary" type="button" data-action="tracks-page" data-page="'+(page-1)+'"'+(page===0?' disabled':'')+'>上一頁</button>'+
        '<span>第 '+(page+1)+' / '+pageCount+' 頁 · '+(start+1)+'–'+Math.min(start+visibleRows.length,rows.length)+' / '+rows.length.toLocaleString()+' 首</span>'+
        '<button class="secondary" type="button" data-action="tracks-page" data-page="'+(page+1)+'"'+(page>=pageCount-1?' disabled':'')+'>下一頁</button></nav>'
      :'<div class="library-pagination library-pagination-single">完整曲庫 · '+rows.length.toLocaleString()+' 首</div>';
    root.innerHTML=searchBar("搜尋曲名、歌手、專輯或路徑")+
      sectionHead("ALL TRACKS","所有歌曲",'<span class="library-muted">'+rows.length.toLocaleString()+' 首 · 每頁 '+TRACKS_PAGE_SIZE+' 首</span>')+
      trackRows(visibleRows,"track",rows,start)+pageControls;
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
    let rootPath="";
    try {
      const configured=options.getMusicRootPath?.();
      if(typeof configured==="string"&&configured.startsWith("/"))rootPath=configured.replace(/\/+$/,"")||"/";
    } catch {}
    if(!rootPath) {
      const roots=[...new Set(state.folders.map(folder=>String(folder.rootPath||"")).filter(path=>path.startsWith("/")))];
      roots.sort((a,b)=>a.localeCompare(b,"zh-Hant"));
      rootPath=roots[0]||"";
    }

    const prefix=rootPath==="/"?"/":rootPath?rootPath+"/":"";
    const isFirstLevel=path=>{
      const normalized=String(path||"").replace(/\/+$/,"");
      if(!prefix||!normalized.startsWith(prefix))return false;
      const relative=normalized.slice(prefix.length);
      return !!relative&&!relative.includes("/");
    };

    // Keep saved folder records (including empty folders), then use indexed track
    // paths to recover first-level folders if an older scan missed folder metadata.
    const foldersByPath=new Map();
    for(const folder of state.folders){
      const path=String(folder.path||"").replace(/\/+$/,"");
      if(!isFirstLevel(path))continue;
      if(folder.rootPath&&folder.rootPath!==rootPath)continue;
      foldersByPath.set(path,{...folder,path,rootPath:folder.rootPath||rootPath});
    }

    const derivedByPath=new Map();
    let tracksUnderRoot=0;
    for(const track of state.tracks){
      const trackPath=String(track.file?.path||track.path||"").replace(/\/+$/,"");
      if(!prefix||!trackPath.startsWith(prefix))continue;
      tracksUnderRoot+=1;
      let folderPath=trackPath.slice(0,trackPath.lastIndexOf("/"))||"/";
      let direct=true;
      while(folderPath!==rootPath&&folderPath.startsWith(prefix)){
        let stats=derivedByPath.get(folderPath);
        if(!stats){
          stats={path:folderPath,name:folderPath.slice(folderPath.lastIndexOf("/") + 1),directTrackCount:0,recursiveTrackCount:0};
          derivedByPath.set(folderPath,stats);
        }
        stats.recursiveTrackCount+=1;
        if(direct)stats.directTrackCount+=1;
        direct=false;
        const slash=folderPath.lastIndexOf("/");
        const parent=slash<=0?"/":folderPath.slice(0,slash);
        if(parent===folderPath)break;
        folderPath=parent;
      }
    }

    let recoveredCount=0;
    for(const [path,stats] of derivedByPath){
      if(!isFirstLevel(path))continue;
      const saved=foldersByPath.get(path);
      if(!saved)recoveredCount+=1;
      foldersByPath.set(path,{
        ...(saved||{}),
        path,
        name:saved?.name||stats.name,
        rootPath,
        directTrackCount:Math.max(Number(saved?.directTrackCount||0),stats.directTrackCount),
        recursiveTrackCount:Math.max(Number(saved?.recursiveTrackCount||0),stats.recursiveTrackCount)
      });
    }

    const query=state.search.toLocaleLowerCase();
    const folders=[...foldersByPath.values()]
      .filter(folder=>!query||[folder.name,folder.path].join(" ").toLocaleLowerCase().includes(query))
      .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"zh-Hant"));
    state.items=folders;state.itemType="folder";
    const countLabel='<span class="library-muted">'+folders.length+' 個根目錄資料夾'+
      (recoveredCount?' · 已依曲目路徑補齊 '+recoveredCount+' 個':'')+'</span>';
    const emptyTitle=!rootPath?"尚未取得 Music 根目錄":
      tracksUnderRoot?"目前沒有可列出的第一層資料夾":"尚未找到已索引的 Music 子資料夾";
    const emptyText=!rootPath?"請先設定 Music 根目錄並完成一次掃描。":
      tracksUnderRoot
        ?"D1 已收錄 "+tracksUnderRoot+" 首位於此根目錄下的歌曲，但目前沒有子資料夾紀錄。若歌曲都直接放在根目錄，這裡不會列出單曲。"
        :"這裡只列出 Music 根目錄下的第一層資料夾。完成掃描後，會優先讀取資料夾索引，並在索引缺漏時依 D1 已收錄歌曲的路徑補足。";
    const empty='<div class="library-empty"><div class="library-empty-mark">▰</div><h3>'+
      emptyTitle+'</h3><p>'+emptyText+(rootPath?'<br>'+esc(rootPath):"")+'</p></div>';
    root.innerHTML=searchBar("搜尋根目錄資料夾")+sectionHead("MUSIC FOLDERS","資料夾歌單",countLabel)+
      (folders.length?'<div class="folder-grid">'+folders.slice(0,500).map((folder,index)=>
        '<button class="folder-card" data-action="open-folder" data-index="'+index+'"><span>▰</span><strong>'+
        esc(displayFolderName(folder.name))+'</strong><small>'+Number(folder.recursiveTrackCount??folder.directTrackCount??0)+
        ' 首歌曲</small><em>'+esc(folder.path)+'</em></button>').join("")+'</div>':empty);
  }
  function renderFolderDetail(){
    const folder=state.selectedFolder;if(!folder){renderFolders();return;}
    const tracks=folderTracks(folder);state.items=tracks;state.itemType="track";
    const name=displayFolderName(folder.name||folder.path.split("/").filter(Boolean).pop()||"未命名資料夾");
    const play=tracks.length?'<button class="primary" type="button" data-action="play-folder">▶ 播放全部</button>':"";
    root.innerHTML='<button class="back-link" type="button" data-action="back-folders">← 返回資料夾歌單</button>'+
      sectionHead("FOLDER CONTENTS",name,'<span class="library-muted">'+tracks.length.toLocaleString()+' 首歌曲</span>')+
      '<div class="playlist-detail-toolbar">'+play+'<span class="library-muted">包含此資料夾內的子資料夾歌曲</span></div>'+
      (tracks.length?trackRows(tracks,"track",tracks):'<div class="library-empty"><div class="library-empty-mark">▰</div><h3>這個資料夾目前沒有已索引歌曲</h3><p>完成音樂索引後，這裡就會列出目前資料夾內的所有曲目。</p></div>');
    loadCovers();
  }
  function renderPlaylists(){
    state.items=state.playlists;state.itemType="playlist";
    const cards=state.playlists.map(playlist=>{
      const favorites=playlist.id===FAVORITES_PLAYLIST_ID;
      return '<button class="playlist-card'+(favorites?" playlist-card-favorites":"")+'" type="button" data-action="open-playlist" data-playlist-id="'+esc(playlist.id)+'">'+
        '<span class="playlist-card-icon">'+(favorites?"♡":"♫")+'</span><strong>'+esc(playlist.name)+'</strong>'+
        '<small>'+playlist.items.length.toLocaleString()+' 首歌曲</small><em>'+(favorites?"預設收藏歌單":"自訂歌單")+'</em></button>';
    }).join("");
    root.innerHTML=sectionHead("YOUR PLAYLISTS","收藏歌單",'<button class="primary" type="button" data-action="open-playlist-creator">＋ 新增歌單</button>')+
      '<p class="library-description">歌曲列右側的「＋」可以加入或移出歌單。收藏夾固定置頂，你建立的歌單會依建立順序排列。</p>'+
      '<div class="playlist-grid">'+cards+'</div>';
  }
  function renderPlaylistDetail(){
    const playlist=findPlaylist(state.selectedPlaylistId);if(!playlist){state.selectedPlaylistId="";renderPlaylists();return;}
    const tracks=resolvePlaylistTracks(playlist);state.items=tracks;state.itemType="track";
    const favorites=playlist.id===FAVORITES_PLAYLIST_ID;
    const actions='<button class="primary" type="button" data-action="play-playlist"'+(tracks.length?"":" disabled")+'>▶ 播放全部</button>'+
      (favorites?"":'<button class="secondary" type="button" data-action="delete-playlist" data-playlist-id="'+esc(playlist.id)+'">刪除歌單</button>');
    root.innerHTML='<button class="back-link" type="button" data-action="back-playlists">← 返回收藏歌單</button>'+
      sectionHead(favorites?"FAVORITES":"CUSTOM PLAYLIST",playlist.name,'<span class="library-muted">'+tracks.length.toLocaleString()+' 首歌曲</span>')+
      '<div class="playlist-detail-toolbar">'+actions+'<span class="library-muted">點擊歌曲即可切換播放，佇列會使用這份歌單的完整曲目</span></div>'+
      (tracks.length?trackRows(tracks,"track",tracks,0,{removeFromPlaylist:true}):
        '<div class="library-empty"><div class="library-empty-mark">'+(favorites?"♡":"♫")+'</div><h3>這份歌單還是空的</h3><p>前往「所有歌曲」或資料夾目錄，點擊歌曲右側的「＋」，就能加入這份歌單。</p></div>');
    loadCovers();
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
    const returningFromNowPlaying=state.view!=="now-playing"&&document.querySelector(".now-playing-page");
    if(returningFromNowPlaying){
      const transport=returningFromNowPlaying.querySelector("#player-transport");
      const detailControls=returningFromNowPlaying.querySelector("#player-detail-controls");
      const dockTransport=document.querySelector(".dock-transport-host");
      const dock=document.querySelector(".dock");
      if(transport&&dockTransport){
        restoreDockTransportToDock(transport,dockTransport);
        animatePlayerControlMove(transport,"return");
      }
      if(detailControls&&dock)dock.append(detailControls);
      returningFromNowPlaying.remove();
      document.body.classList.toggle("is-podcast-view",["shows","show-detail","continue"].includes(state.view));
      document.body.classList.remove("is-now-playing");
      $("#player-now-playing")?.setAttribute("aria-label","展開正在播放頁面");
      syncActiveNavigation();
      root.classList.remove("view-enter");
      return;
    }
    if(!state.loaded){message("正在讀取曲庫……");void load(true);return;}
    switch(state.view){
      case "music":renderHome();break;
      case "tracks":renderTracks();break;
      case "albums":renderAlbums();break;
      case "album-detail":renderAlbumDetail();break;
      case "playlists":renderPlaylists();break;
      case "folders":if(state.selectedFolder)renderFolderDetail();else renderFolders();break;
      case "shows":renderShows();break;
      case "show-detail":renderShowDetail();break;
      case "continue":void renderContinue().catch(e=>message(e.message,"error"));break;
      case "reports":void renderReports().catch(e=>message(e.message,"error"));break;
      case "errors":void renderErrors().catch(e=>message(e.message,"error"));break;
      case "now-playing":renderNowPlaying();break;
      default:renderHome();
    }
    syncActiveNavigation();
    document.body.classList.toggle("is-podcast-view",["shows","show-detail","continue"].includes(state.view));
    document.body.classList.toggle("is-now-playing",state.view==="now-playing");
    $("#player-now-playing")?.setAttribute("aria-label",state.view==="now-playing"?"收起正在播放頁面":"展開正在播放頁面");
    animateLibraryContent();
  }

  function renderPlayerQueue(options={}) {
    const list = $("#player-queue-list");
    const summary = $("#player-queue-summary");
    const count = $("#player-queue-count");
    const toggle = $("#player-queue-toggle");
    if (!list) return;

    if(list.dataset.virtualScrollBound!=="true"){
      list.addEventListener("scroll",()=>{
        if(queueRenderFrame)return;
        queueRenderFrame=window.requestAnimationFrame(()=>{
          queueRenderFrame=0;
          renderPlayerQueue({preserveScroll:true});
        });
      },{passive:true});
      list.dataset.virtualScrollBound="true";
    }

    const queue = Array.isArray(state.queue) ? state.queue : [];
    const total = queue.length;
    const previousScrollTop=Number(list.scrollTop)||0;
    if (count) count.textContent = total.toLocaleString();
    if (toggle) {
      toggle.setAttribute("aria-label", total ? "播放列表，" + total.toLocaleString() + " 首" : "播放列表，尚無待播項目");
      toggle.title = total ? "播放列表 · " + total.toLocaleString() + " 首" : "播放列表";
      toggle.classList.toggle("has-queue", total > 0);
    }
    const heading=$("#player-queue-heading");
    const queueLabel=String(state.queueLabel||"播放列表");
    if(heading){heading.textContent=total?queueLabel:"播放列表";heading.title=total?queueLabel:"播放列表";}
    if (summary) {
      summary.textContent = total
        ? total.toLocaleString() + " 首 · " + (state.shuffleEnabled ? "隨機播放順序" : "目前播放順序") + " · 虛擬列表"
        : "尚未建立播放佇列";
    }

    list.replaceChildren();
    if (!total) {
      const empty = document.createElement("div");
      empty.className = "player-queue-empty";
      empty.textContent = "從歌曲、專輯、歌手、資料夾或 Podcast 節目開始播放，這裡就會顯示待播項目。";
      list.append(empty);
      return;
    }

    const order = state.shuffleEnabled && state.shuffleOrder.length === total
      ? state.shuffleOrder
      : null;
    const itemType = state.currentItem?.itemType || "track";
    const rowHeight=window.matchMedia("(max-width:760px)").matches?QUEUE_ROW_HEIGHT_MOBILE:QUEUE_ROW_HEIGHT_DESKTOP;
    const viewportHeight=Math.max(180,list.clientHeight||400);
    const maxScrollTop=Math.max(0,total*rowHeight-viewportHeight);
    let scrollTop=Math.min(previousScrollTop,maxScrollTop);
    if(options.focusCurrent&&state.queueIndex>=0&&state.queueIndex<total){
      const visibleCurrent=order?order.indexOf(state.queueIndex):state.queueIndex;
      if(visibleCurrent>=0)scrollTop=Math.min(maxScrollTop,Math.max(0,visibleCurrent*rowHeight-(viewportHeight-rowHeight)/2));
    }
    const firstVisible=Math.min(total-1,Math.max(0,Math.floor(scrollTop/rowHeight)));
    const start=Math.max(0,firstVisible-QUEUE_OVERSCAN);
    const visibleCount=Math.ceil(viewportHeight/rowHeight)+QUEUE_OVERSCAN*2;
    const end=Math.min(total,start+visibleCount);
    const spacer=(height)=>{
      const node=document.createElement("div");
      node.className="player-queue-virtual-spacer";
      node.setAttribute("aria-hidden","true");
      node.style.height=Math.max(0,height)+"px";
      return node;
    };
    if(start>0)list.append(spacer(start*rowHeight));

    for(let visibleIndex=start;visibleIndex<end;visibleIndex+=1){
      const queueIndex=order?order[visibleIndex]:visibleIndex;
      const raw=queue[queueIndex];
      if(!raw)continue;
      const item=playable(raw,itemType);
      const current=queueIndex===state.queueIndex;
      const row=document.createElement("button");
      row.type="button";
      row.className="player-queue-item"+(current?" is-current":"");
      row.dataset.queueIndex=String(queueIndex);
      row.setAttribute("aria-label",(visibleIndex+1)+" · "+item.title+(current?" · 正在播放":" · 待播"));
      if(current)row.setAttribute("aria-current","true");

      const listItem=document.createElement("div");
      listItem.className="player-queue-virtual-row";
      listItem.setAttribute("role","listitem");
      listItem.setAttribute("aria-posinset",String(visibleIndex+1));
      listItem.setAttribute("aria-setsize",String(total));
      listItem.style.height=rowHeight+"px";

      const number=document.createElement("span");
      number.className="player-queue-number";
      number.textContent=String(visibleIndex+1).padStart(2,"0");

      const copy=document.createElement("span");
      copy.className="player-queue-copy";
      const title=document.createElement("strong");
      title.className="player-queue-title";
      title.textContent=item.title;
      const subtitle=document.createElement("small");
      subtitle.className="player-queue-subtitle";
      subtitle.textContent=item.subtitle||(item.itemType==="episode"?"Podcast 單集":"音樂曲目");
      copy.append(title,subtitle);

      const status=document.createElement("span");
      status.className="player-queue-status";
      status.textContent=current?"正在播放":"待播";
      row.append(number,copy,status);
      listItem.append(row);
      list.append(listItem);
    }
    if(end<total)list.append(spacer((total-end)*rowHeight));
    list.scrollTop=scrollTop;
  }
  function setDock(item) {
    syncMediaSessionMetadata(item);
    renderPlayerQueue();
    $("#player-title").textContent=item?.title||"尚未選擇音訊";
    const artist=item?(item.subtitle||item.albumArtist||item.album||(item.itemType==="episode"?"Podcast":"")):"";
    $("#player-subtitle").textContent=artist||"選擇歌曲後即可播放";
    const artistSeparator=$(".now-copy-separator");
    if(artistSeparator)artistSeparator.hidden=!artist;
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
  function updateMediaPositionState(force=false) {
    const session = navigator.mediaSession;
    if (!session || typeof session.setPositionState !== "function" || !state.currentItem) return;
    const mediaDuration = Number(audio.duration);
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
    const currentPosition = Math.max(0, Math.min(mediaDuration, Number(audio.currentTime) || 0));
    const now = performance.now();
    if (!force && now - lastMediaPositionUpdate < 900) return;
    try {
      session.setPositionState({
        duration: mediaDuration,
        position: currentPosition,
        playbackRate: Number(audio.playbackRate) > 0 ? Number(audio.playbackRate) : 1
      });
      lastMediaPositionUpdate = now;
    } catch {
      // Some iOS/Safari builds expose Media Session but not position state.
    }
  }

  function syncMediaSessionPlaybackState(forcePosition=true) {
    const session = navigator.mediaSession;
    if (session) {
      try {
        session.playbackState = !state.currentItem ? "none" : audio.paused ? "paused" : "playing";
      } catch {}
    }
    if (forcePosition) updateMediaPositionState(true);
  }

  function syncMediaSessionMetadata(item) {
    const session = navigator.mediaSession;
    const title = item?.title || "";
    const artist = item ? (item.subtitle || item.artist || (Array.isArray(item.artists) ? item.artists.join(" / ") : "") || item.albumArtist || item.album || (item.itemType === "episode" ? "Podcast" : "")) : "";
    document.title = item
      ? [title, artist].filter(Boolean).join(" · ") + " | FRAME Audio"
      : defaultDocumentTitle;
    if (!session) return;

    const artworkHash = item ? String(item.artworkHash || item.artwork_hash || item.artwork?.sha256 || "") : "";
    const itemKey = item ? [String(item.itemType || "audio"), String(item.id || item.path || title), artworkHash].join(":") : "";
    const changed = itemKey !== mediaMetadataItemKey;
    mediaMetadataItemKey = itemKey;
    try {
      if (!item) {
        session.metadata = null;
        session.playbackState = "none";
        if (typeof session.setPositionState === "function") session.setPositionState({});
        lastMediaPositionUpdate = 0;
        mediaSessionArtworkRequestId++;
        mediaSessionArtworkPendingKey = "";
        if (mediaSessionArtworkObjectUrl) URL.revokeObjectURL(mediaSessionArtworkObjectUrl);
        mediaSessionArtworkObjectUrl = "";
        mediaSessionArtworkObjectUrlKey = "";
        return;
      }
      if (typeof MediaMetadata !== "undefined") {
        const album = String(item.album || item.showTitle || (item.itemType === "episode" ? artist : "") || "");
        const metadata = {
          title: String(title || "未命名音訊"),
          artist: String(artist || "FRAME Audio"),
          album
        };
        let artworkUrl = "";
        if (artworkHash) {
          artworkUrl = new URL("/api/artwork/" + encodeURIComponent(artworkHash), window.location.origin).href;
          if (mediaSessionArtworkObjectUrl && mediaSessionArtworkObjectUrlKey === itemKey) {
            metadata.artwork = [{ src: mediaSessionArtworkObjectUrl }];
          } else {
            // Resolve the protected artwork inside the authenticated page.
            // Media Session receives a blob URL, not a private API URL that
            // the OS/Bluetooth metadata consumer would need to authorize.
            metadata.artwork = [{ src: artworkUrl }];
          }
        }
        session.metadata = new MediaMetadata(metadata);

        if (!artworkHash) {
          mediaSessionArtworkRequestId++;
          mediaSessionArtworkPendingKey = "";
          if (mediaSessionArtworkObjectUrl) URL.revokeObjectURL(mediaSessionArtworkObjectUrl);
          mediaSessionArtworkObjectUrl = "";
          mediaSessionArtworkObjectUrlKey = "";
        } else if (mediaSessionArtworkObjectUrlKey !== itemKey && mediaSessionArtworkPendingKey !== itemKey) {
          mediaSessionArtworkPendingKey = itemKey;
          const requestId = ++mediaSessionArtworkRequestId;
          fetch(artworkUrl, { credentials: "same-origin", cache: "force-cache" })
            .then(response => response.ok ? response.blob() : null)
            .then(blob => {
              if (!blob || !blob.size || (blob.type && !/^image\//i.test(blob.type))) {
                throw new Error("Media Session artwork could not be loaded.");
              }
              if (requestId !== mediaSessionArtworkRequestId || mediaMetadataItemKey !== itemKey) return;
              const nextUrl = URL.createObjectURL(blob);
              const previousUrl = mediaSessionArtworkObjectUrl;
              mediaSessionArtworkObjectUrl = nextUrl;
              mediaSessionArtworkObjectUrlKey = itemKey;
              mediaSessionArtworkPendingKey = "";
              session.metadata = new MediaMetadata({
                ...metadata,
                artwork: [{ src: nextUrl, ...(blob.type ? { type: blob.type } : {}) }]
              });
              if (previousUrl && previousUrl !== nextUrl) URL.revokeObjectURL(previousUrl);
            })
            .catch(() => {
              if (requestId === mediaSessionArtworkRequestId) mediaSessionArtworkPendingKey = "";
            });
        }
      }
      session.playbackState = audio.paused ? "paused" : "playing";
      if (changed && typeof session.setPositionState === "function") {
        session.setPositionState({});
        lastMediaPositionUpdate = 0;
      } else {
        updateMediaPositionState(true);
      }
    } catch {
      // Keep HTML5 playback working even when the platform rejects metadata.
    }
  }

  function setupMediaSessionActions() {
    const session = navigator.mediaSession;
    if (!session || typeof session.setActionHandler !== "function") return;
    const handlers = {
      play: () => { if (state.currentItem && audio.src && audio.paused) audio.play().catch(() => {}); },
      pause: () => { if (!audio.paused) audio.pause(); },
      previoustrack: () => next(-1),
      nexttrack: () => next(1),
      seekbackward: details => {
        const offset = Number(details?.seekOffset) > 0 ? Number(details.seekOffset) : 10;
        audio.currentTime = Math.max(0, Number(audio.currentTime || 0) - offset);
        updateMediaPositionState(true);
      },
      seekforward: details => {
        const offset = Number(details?.seekOffset) > 0 ? Number(details.seekOffset) : 10;
        const target = Number(audio.currentTime || 0) + offset;
        audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, target) : target;
        updateMediaPositionState(true);
      },
      seekto: details => {
        const position = Number(details?.seekTime);
        if (!Number.isFinite(position) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
        const target = Math.max(0, Math.min(audio.duration, position));
        if (details?.fastSeek && typeof audio.fastSeek === "function") audio.fastSeek(target);
        else audio.currentTime = target;
        updateMediaPositionState(true);
        timeline();
      },
      stop: () => $("#player-stop")?.click()
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { session.setActionHandler(action, handler); }
      catch {
        // Unsupported actions are omitted individually; supported actions remain active.
      }
    }
  }

  function timeline() {
    const d=Number(audio.duration||0),p=Number(audio.currentTime||0);
    $("#player-seek").value=d>0?String(Math.round(p/d*1000)):"0";
    $("#player-current").textContent=duration(p*1000);
    $("#player-duration").textContent=duration((d||state.currentItem?.durationMs/1000||0)*1000);
    updateMediaPositionState();
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
    activeAudioTimingCleanup?.();
    activeAudioTimingCleanup = null;
    const requestId=++state.playRequestId;
    const isCurrentRequest=()=>requestId===state.playRequestId;
    const config=getConfig();
    const providerLabel=playbackProviderLabel(config.provider);
    activePlaybackProviderLabel=providerLabel;
    if(!config.connected||!config.storageReady||!config.baseUrl){
      appendPlaybackLog("播放中止 · "+providerLabel+" 或 Cloudflare D1 / R2 尚未就緒。","error");
      setPlaybackConnectionStatus(providerLabel+" 尚未就緒，請先完成連線測試。","error",requestId,10000);
      message(providerLabel+" 或 Cloudflare 連線尚未就緒。","error");
      $("#open-settings")?.click();
      return;
    }
    const item=playable(raw,type);
    if(!item.path||!item.id){
      appendPlaybackLog("播放中止 · 索引項目缺少檔案路徑或識別碼。","error");
      setPlaybackConnectionStatus("播放項目資料不完整。","error",requestId,10000);
      message("這筆索引缺少檔案路徑或識別碼。","error");
      return;
    }

    appendPlaybackLog("開始播放請求 · "+(item.title||"未命名音訊")+" · "+providerLabel+" · "+(type==="episode"?"Podcast":"Music"));
    appendPlaybackLog("檔案路徑："+item.path);
    setPlaybackConnectionStatus("正在連接 "+providerLabel+"…","connecting",requestId);

    const cachedEntry=state.preloadEntry?.itemId===item.id&&state.preloadEntry?.path===item.path
      ? state.preloadEntry : null;
    if(!cachedEntry)clearNextPreload();

    try {
      const infoStartedAt=performance.now();
      appendPlaybackLog(cachedEntry?.promise?"使用下一首預載的檔案資訊。":"向 "+providerLabel+" 請求檔案資訊（/api/fs/get）……");
      const requestFileInfo=()=>getOpenListFileInfo({
        baseUrl:config.baseUrl,
        path:item.path,
        timeoutMs:180000,
        onTiming:timing=>appendPlaybackLog(
          "檔案資訊 API HTTP "+timing.status+" · response "+timing.responseMs+" ms · JSON "+timing.bodyMs+" ms"+
          (timing.serverTiming?" · Server-Timing: "+timing.serverTiming:""),
          timing.status>=200&&timing.status<300?"success":"warning"
        )
      });
      const infoRequest=cachedEntry?.promise
        ? cachedEntry.promise.then(info=>{
            if(info){appendPlaybackLog("已沿用預載檔案資訊。","success");return info;}
            return requestFileInfo();
          })
        : requestFileInfo();
      const infoPromise=infoRequest.then(info=>({info,elapsedMs:Math.round(performance.now()-infoStartedAt)}));
      const progressStartedAt=performance.now();
      const progressPromise=type==="episode"
        ? api("/api/listening?view=progress&itemType="+type+"&itemId="+encodeURIComponent(item.id))
            .then(data=>({data,elapsedMs:Math.round(performance.now()-progressStartedAt)}))
            .catch(error=>{
              appendPlaybackLog("Podcast 收聽進度查詢失敗，將從頭播放 · "+(error?.message||error),"warning");
              return {data:{item:null},elapsedMs:Math.round(performance.now()-progressStartedAt)};
            })
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
      if(type==="episode")appendPlaybackLog("Podcast 收聽進度查詢完成 · "+progressLookupMs+" ms。");
      if(!info||info.is_dir)throw new Error(providerLabel+" 回傳的項目是資料夾，不是音訊檔案。");
      if(!info.raw_url)throw new Error(providerLabel+" /api/fs/get 沒有提供 raw_url。");
      if(!Number.isFinite(Number(info.size))||Number(info.size)<=0)throw new Error(providerLabel+" 沒有提供有效檔案大小。");
      let audioHost="未知";
      try{audioHost=new URL(String(info.raw_url),config.baseUrl||window.location.href).host;}catch{}
      appendPlaybackLog("檔案資訊取得完成 · "+fileInfoElapsedMs+" ms · "+Number(info.size).toLocaleString()+" bytes · raw_url 初始主機 "+audioHost,"success");
      setPlaybackConnectionStatus("已連接 "+providerLabel+"，正在啟動音訊…","loading",requestId);

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
       syncActiveNavigation();
      if(playOptions.preserveQueue){
        state.queueIndex=index;
        if(state.shuffleOrder.length!==state.queue.length)rebuildShuffleOrder(index);
        state.shufflePosition=state.shuffleOrder.indexOf(index);
      }else{
        state.queue=queue.map(x=>({...x}));
        state.queueIndex=index;
        state.queueLabel=String(playOptions.queueLabel||defaultQueueLabel(type,item)).slice(0,240);
        rebuildShuffleOrder(index);
      }
      state.session=null;
      const requestedRestoreMs=Number(playOptions.restorePositionMs);
      state.restorePositionMs=Number.isFinite(requestedRestoreMs)&&requestedRestoreMs>=0
        ?requestedRestoreMs:type==="episode"?Number(saved.item?.position_ms||0):0;
      state.restoredPlaybackPending=false;
      state.lastProgressSave=0;
      state.speed=type==="episode"&&Number.isFinite(Number(saved.item?.playback_rate))
        ?Math.min(2,Math.max(.5,Number(saved.item.playback_rate))):1;
      $("#player-speed").value=String(state.speed);
      savePlaybackQueueState();savePlaybackPosition(true,state.restorePositionMs);
      setDock(item);
      $("#player-type").textContent=(type==="episode"?"PODCAST":"MUSIC")+" · "+providerLabel.toUpperCase();

      const mediaLoadStartedAt=performance.now();
      activeAudioTimingCleanup = attachAudioStartupTiming(audio, mediaLoadStartedAt, {
        requestId,
        provider: config.provider || "vps",
        providerLabel,
        itemTitle: item.title,
        source: cachedEntry ? "next-preload" : "api",
        fileInfoMs: fileInfoElapsedMs,
        podcastProgressMs: type === "episode" ? progressLookupMs : null
      });
      const warmedAudio=cachedEntry?.audio||null;
      if(cachedEntry&&state.preloadEntry===cachedEntry){
        state.preloadEntry=null;
        state.preloadAudio=null;
      }
      appendPlaybackLog("設定 HTMLAudioElement 音訊來源 · direct raw_url · host "+audioHost+"；Cloudflare Pages 不代理音訊資料。");
      audio.src=info.raw_url;
      audio.load();
      audio.playbackRate=state.speed;
      setPlaybackConnectionStatus("檔案資訊已取得，正在連接音訊串流…","loading",requestId);
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
        appendPlaybackLog("呼叫 HTMLMediaElement.play()。");
        await audio.play();
        if(!isCurrentRequest())return;
        appendPlaybackLog("HTMLMediaElement.play() Promise 已完成，等待瀏覽器觸發 playing 事件。","success");
        console.info("[FRAME Audio] Playback started", {
          fileInfoMs:fileInfoElapsedMs,
          podcastProgressMs:type==="episode"?progressLookupMs:null,
          mediaStartMs:Math.round(performance.now()-mediaLoadStartedAt),
          totalMs:Math.round(performance.now()-selectionStartedAt),
          transport:"direct-raw-url-302"
        });
        $("#player-toggle").textContent="Ⅱ";
      } catch(e) {
        activeAudioTimingCleanup?.();
        activeAudioTimingCleanup = null;
        if(!isCurrentRequest()||isPlaybackInterruption(e))return;
        $("#player-toggle").textContent="▶";
        appendPlaybackLog("播放啟動失敗 · "+(e?.name||"Error")+" · "+(e?.message||e),"error");
        setPlaybackConnectionStatus(providerLabel+" 播放啟動失敗："+(e?.message||e),"error",requestId,10000);
        message(providerLabel+" 音訊網址已載入，但瀏覽器未能開始播放。"+(e.message?" "+e.message:""),"error");
      }
    }catch(e){
      if(!isCurrentRequest())return;
      activeAudioTimingCleanup?.();
      activeAudioTimingCleanup = null;
      appendPlaybackLog("播放準備失敗 · "+(e?.name||"Error")+" · "+(e?.message||e),"error");
      setPlaybackConnectionStatus(providerLabel+" 連線失敗："+(e?.message||e),"error",requestId,12000);
      message(providerLabel+" 播放失敗（未切換其他來源）："+(e.message||e),"error");
    }
  }

  function next(delta) {
    if (!state.queue.length || state.queueIndex < 0 || !state.currentItem) return;
    if (delta < 0 && Number(audio.currentTime || 0) > 3) {
      audio.currentTime = 0;
      updateMediaPositionState(true);
      return;
    }
    const target = nextQueueIndex(delta);
    if (target < 0 || target >= state.queue.length) return;
    void playItem(state.currentItem.itemType, state.queue[target], state.queue, target, { preserveQueue: true });
  }
  setupMediaSessionActions();

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
    if(lyricLine&&(root.contains(lyricLine)||lyricLine.closest(".now-playing-page"))){
      const cue=state.lyricsCues[Number(lyricLine.dataset.lyricIndex)];
      if(cue&&Number.isFinite(cue.time)){audio.currentTime=cue.time;syncLyricsHighlight();}
      return;
    }
    const b=event.target.closest("[data-action]");if(!b)return;
    const action=b.dataset.action,i=Number(b.dataset.index);
    try{
      if(action==="navigate"){showView(b.dataset.view);return;}
      if(action==="back-now-playing"){closeNowPlaying();return;}
      if(action==="open-playlist-creator"){openPlaylistDialog();return;}
      if(action==="open-playlist-picker"){const item=state.items[i];if(item)openPlaylistDialog(item);return;}
      if(action==="close-playlist-dialog"){const dialog=$("#playlist-picker-dialog");if(dialog?.open)dialog.close();return;}
      if(action==="toggle-playlist-membership"){
        const playlist=findPlaylist(b.dataset.playlistId),item=state.playlistDialogItem;if(!playlist||!item)return;
        const added=togglePlaylistItem(playlist,item);renderPlaylistPicker();
        const status=$("#playlist-dialog-status");if(status)status.textContent=added?"已加入「"+playlist.name+"」。":"已從「"+playlist.name+"」移除。";return;
      }
      if(action==="save-playlist"){
        try{
          const playlist=createUserPlaylist($("#playlist-new-name")?.value||"");
          if(state.playlistDialogItem)togglePlaylistItem(playlist,state.playlistDialogItem,true);
          const dialog=$("#playlist-picker-dialog");if(dialog?.open)dialog.close();state.playlistDialogItem=null;
          if(state.view==="playlists"&&!state.selectedPlaylistId)renderPlaylists();
          message("已建立歌單「"+playlist.name+"」。","success");
        }catch(error){const status=$("#playlist-dialog-status");if(status)status.textContent=error.message||"建立歌單失敗。";}
        return;
      }
      if(action==="open-playlist"){
        const playlist=findPlaylist(b.dataset.playlistId);if(!playlist)return;
        state.selectedPlaylistId=playlist.id;renderPlaylistDetail();animateLibraryContent();return;
      }
      if(action==="back-playlists"){state.selectedPlaylistId="";renderPlaylists();animateLibraryContent();return;}
      if(action==="delete-playlist"){
        const playlist=findPlaylist(b.dataset.playlistId);if(!playlist||playlist.id===FAVORITES_PLAYLIST_ID)return;
        if(!window.confirm("確定刪除「"+playlist.name+"」？只會刪除這份歌單，不會刪除原始音訊。"))return;
        state.playlists=state.playlists.filter(entry=>entry.id!==playlist.id);state.selectedPlaylistId="";
        saveUserPlaylists();renderPlaylists();animateLibraryContent();return;
      }
      if(action==="remove-from-playlist"){
        const playlist=findPlaylist(state.selectedPlaylistId),item=state.items[i];if(!playlist||!item)return;
        togglePlaylistItem(playlist,item,false);renderPlaylistDetail();return;
      }
      if(action==="back-folders"){state.selectedFolder=null;renderFolders();animateLibraryContent();return;}
      if(action==="open-folder"){
        const folder=state.items[i];if(!folder)return;state.selectedFolder=folder;renderFolderDetail();animateLibraryContent();return;
      }
      if(action==="play-folder"){
        const folder=state.selectedFolder,list=folderTracks(folder);
        if(list.length)await playItem("track",list[0],list,0,{queueLabel:"資料夾 / "+displayFolderName(folder?.name||folder?.path?.split("/").filter(Boolean).pop()||"未命名資料夾")});
        return;
      }
      if(action==="play-playlist"){
        const playlist=findPlaylist(state.selectedPlaylistId),list=resolvePlaylistTracks(playlist);
        if(list.length)await playItem("track",list[0],list,0,{queueLabel:playlist?.id===FAVORITES_PLAYLIST_ID?"收藏夾":"歌單 / "+String(playlist?.name||"播放列表")});
        return;
      }
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
      if(action==="tracks-page"){
        const nextPage=Number(b.dataset.page);
        if(!Number.isInteger(nextPage))return;
        state.trackPage=Math.max(0,nextPage);
        renderTracks();
        animateLibraryContent();
        root.scrollIntoView({block:"start",behavior:"smooth"});
        return;
      }
      if(action==="play"){
        const item=state.items[i];
        if(state.itemType==="continue"){
          const p=item;
          await playItem("episode",{id:p.item_id,title:p.title,showTitle:p.subtitle,path:p.path,artworkHash:p.artwork_hash,durationMs:p.duration_ms},[item],0,{
            queueLabel:"繼續收聽 / "+String(p.subtitle||"Podcast")
          });
        }else{
          await playItem(state.itemType,item,state.items,i,{queueLabel:defaultQueueLabel(state.itemType,item)});
        }
        return;
      }
      if(action==="play-album"){
        const album=state.selectedAlbum;
        const list=orderedAlbumTracks(album?.tracks||[]);
        const queueLabel=album?"專輯 / "+String(album.title||"未命名專輯")+(album.artist?"（"+album.artist+"）":""):"專輯";
        if(list.length)await playItem("track",list[0],list,0,{queueLabel});return;
      }
      if(action==="refresh-album-metadata"){await refreshAlbumMetadata();return;}
      if(action==="play-show"){
        const show=state.shows.find(s=>s.id===state.selectedShowId),list=state.episodes.filter(e=>e.showId===show?.id).map(e=>({...e,showTitle:show.title}));
        if(list.length)await playItem("episode",list[0],list,0,{queueLabel:"Podcast / "+String(show?.title||"節目")});return;
      }
      if(action==="play-group"){
        const group=state.items[i];if(!group)return;
        let list=[],queueLabel="音樂";
        if(state.itemType==="artist"){
          list=group[1];
          queueLabel="歌手 / "+String(group[0]||"未知歌手");
        }else if(state.itemType==="folder"){
          list=state.tracks.filter(t=>t.file?.path===group.path||t.file?.path?.startsWith(group.path.replace(/\/$/,"")+"/"));
          queueLabel="資料夾 / "+displayFolderName(group.name||group.path.split("/").filter(Boolean).pop()||"未命名資料夾");
        }
        if(list.length)await playItem("track",list[0],list,0,{queueLabel});return;
      }
      if(action==="report-type"){state.reportType=b.dataset.value;await renderReports();return;}
      if(action==="report-period"){state.reportPeriod=b.dataset.value;await renderReports();return;}
      if(action==="refresh-errors"){await renderErrors();return;}
      if(action==="reindex-error"){await reindexError(i);return;}
    }catch(e){message(e.message||"操作失敗。","error");}
  }
  root.addEventListener("click",handleClick);
  $("#playlist-picker-dialog")?.addEventListener("click",handleClick);
  $("#playlist-new-name")?.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();$("#playlist-create-submit")?.click();}});
  function refreshSearchResults(input) {
    if(!input)return;
    const nextSearch=input.value;
    if(state.view==="tracks")state.trackPage=0;
    state.search=nextSearch;
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
  $("#playback-log-copy")?.addEventListener("click",async()=>{
    if(!playbackLogEntries.length)return;
    try{
      await navigator.clipboard.writeText(playbackLogEntries.join("\n"));
      const button=$("#playback-log-copy");
      if(button){const label=button.textContent;button.textContent="已複製";window.setTimeout(()=>{button.textContent=label;},1200);}
    }catch(error){appendPlaybackLog("複製日誌失敗 · "+(error?.message||error),"warning");}
  });
  $("#playback-log-clear")?.addEventListener("click",()=>{
    playbackLogEntries.length=0;
    const output=$("#playback-log-output");
    if(output)output.innerHTML='<div class="playback-log-placeholder">尚無日誌。選擇歌曲或 Podcast 單集後，這裡會記錄連線與播放事件。</div>';
    const count=$("#playback-log-count");
    if(count)count.textContent="0 筆";
  });
  audio.addEventListener("error",()=>{
    if(!state.currentItem||!audio.src)return;
    const code=audio.error?audio.error.code:"未知";
    $("#player-toggle").textContent="▶";
    $("#player-type").textContent=activePlaybackProviderLabel.toUpperCase()+" ERROR";
    $("#player-subtitle").textContent=activePlaybackProviderLabel+" 音訊載入失敗，MediaError code："+code+"。未自動切換其他來源。";
    if(!activeAudioTimingCleanup){
      appendPlaybackLog("HTML5 Audio 發生錯誤 · MediaError code="+code+" · "+(audio.error?.message||"無更多錯誤資訊"),"error");
      setPlaybackConnectionStatus(activePlaybackProviderLabel+" 音訊載入失敗 · MediaError "+code,"error",state.playRequestId,10000);
    }
    syncMediaSessionPlaybackState();
    console.error("[FRAME Audio] "+activePlaybackProviderLabel+" HTML5 Audio MediaError code:",code);
  });
  audio.addEventListener("play",()=>{
    startSession();saveProgress(true);savePlaybackPosition(true);
    if(state.currentItem?.itemType==="track"){
      const id=String(state.currentItem.id||state.currentItem.item_id||""),path=pathOf(state.currentItem);
      state.recentTracks=[state.currentItem,...state.recentTracks.filter(item=>
        !(id&&String(item.id||item.item_id||"")===id)&&!(path&&pathOf(item)===path)
      )].slice(0,8);
    }
    $("#player-toggle").textContent="Ⅱ";
    document.body.classList.add("is-audio-playing");
    // Re-publish after the media element starts and the browser can activate
    // this tab's media session (important for iOS Lock Screen artwork).
    syncMediaSessionMetadata(state.currentItem);
    syncMediaSessionPlaybackState();
  });
  audio.addEventListener("playing",()=>{
    // Re-publish once playback is active for Bluetooth/AVRCP metadata.
    syncMediaSessionMetadata(state.currentItem);
    syncMediaSessionPlaybackState();
  });
  audio.addEventListener("pause",()=>{
    accountTime();persistSession(false);saveProgress(true);savePlaybackPosition(true);savePlaybackQueueState();$("#player-toggle").textContent="▶";
    document.body.classList.remove("is-audio-playing");
    syncMediaSessionPlaybackState();
  });
  audio.addEventListener("loadedmetadata",()=>{
    if(state.restorePositionMs>3000&&Number.isFinite(audio.duration)&&state.restorePositionMs<audio.duration*1000-5000)audio.currentTime=state.restorePositionMs/1000;
    state.restorePositionMs=0;timeline();updateMediaPositionState(true);maybePreloadNextItem();
  });
  audio.addEventListener("durationchange",()=>updateMediaPositionState(true));
  audio.addEventListener("seeked",()=>{updateMediaPositionState(true);savePlaybackPosition(true);});
  audio.addEventListener("ratechange",()=>{updateMediaPositionState(true);savePlaybackQueueState();});
  audio.addEventListener("timeupdate",()=>{timeline();syncLyricsHighlight();maybePreloadNextItem();savePlaybackPosition(false);});
  audio.addEventListener("ended",()=>{
    accountTime();persistSession(true);saveProgress(true);state.session=null;
    if(state.playMode==="repeat-one"){
      audio.currentTime=0;
      audio.play().catch(error=>message(error.message||"單曲循環播放失敗。","error"));
      return;
    }
    const targetIndex=nextQueueIndex(1);
    if(targetIndex>=0&&targetIndex<state.queue.length){
      console.info("[FRAME Audio] Queue ended; advancing to next track",{
        queueIndex:state.queueIndex,nextQueueIndex:targetIndex,queueLength:state.queue.length,
        playMode:state.playMode,shuffleEnabled:state.shuffleEnabled
      });
      void playItem(state.currentItem.itemType,state.queue[targetIndex],state.queue,targetIndex,{preserveQueue:true});
    }else{
      clearNextPreload();
      $("#player-toggle").textContent="▶";
      document.body.classList.remove("is-audio-playing");
      syncMediaSessionPlaybackState();
      console.info("[FRAME Audio] Queue finished",{
        queueIndex:state.queueIndex,queueLength:state.queue.length,
        playMode:state.playMode,shuffleEnabled:state.shuffleEnabled
      });
    }
  });
  $("#player-toggle")?.addEventListener("click",()=>{
    if(!audio.src){
      if(state.restoredPlaybackPending&&state.currentItem&&state.queue[state.queueIndex]){
        void playItem(state.currentItem.itemType,state.queue[state.queueIndex],state.queue,state.queueIndex,{
          preserveQueue:true,restorePositionMs:state.restorePositionMs
        });
        return;
      }
      message("請先從曲庫選擇歌曲或 Podcast 單集。");return;
    }
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
    appendPlaybackLog("使用者停止播放。");
    setPlaybackConnectionStatus("已停止播放。","idle",state.playRequestId,1400);
    clearNextPreload();
    accountTime();persistSession(false);saveProgress(true);audio.pause();audio.removeAttribute("src");audio.removeAttribute("crossorigin");audio.load();
    state.currentItem=null;state.session=null;state.queue=[];state.queueIndex=-1;state.shuffleOrder=[];state.shufflePosition=-1;state.restorePositionMs=0;clearSavedPlaybackState();setDock(null);timeline();
  });
  $("#player-seek")?.addEventListener("change",e=>{if(Number.isFinite(audio.duration)&&audio.duration>0)audio.currentTime=audio.duration*Number(e.target.value)/1000;});
  $("#player-speed")?.addEventListener("change",e=>{state.speed=Math.min(2,Math.max(.5,Number(e.target.value)||1));audio.playbackRate=state.speed;if(state.currentItem?.itemType==="episode")saveProgress(true);savePlaybackQueueState();});

  $("#player-shuffle")?.addEventListener("click",()=>{
    state.shuffleEnabled=!state.shuffleEnabled;
    clearNextPreload();
    rebuildShuffleOrder(state.queueIndex);
    updateShuffleButton();
    renderPlayerQueue();
    savePlayerPreferences();
    savePlaybackQueueState();
  });
  $("#player-mode")?.addEventListener("click",()=>{
    const index=PLAY_MODES.indexOf(state.playMode);
    state.playMode=PLAY_MODES[(index+1)%PLAY_MODES.length];
    clearNextPreload();
    updatePlayerModeButton();savePlayerPreferences();savePlaybackQueueState();
  });
  $("#lyrics-close")?.addEventListener("click",()=>$("#lyrics-dialog")?.close());
  $("#player-lyrics")?.addEventListener("click",()=>{
    if(!state.currentItem){message("請先播放一首歌曲。");return;}
    renderLyricsPanel();openModal($("#lyrics-dialog"));syncLyricsHighlight();
  });
  $("#player-now-playing")?.addEventListener("click",()=>{
    if(!state.currentItem){message("請先從曲庫選擇音訊。");return;}
    options.closeMobileNavigation?.();
    if(state.view==="now-playing")closeNowPlaying();
    else void showView("now-playing");
  });
  let queuePanelCloseTimer = 0;
  let queuePanelTransitionId = 0;
  function setPlayerQueueOpen(open, restoreFocus = false) {
    const panel = $("#player-queue-panel");
    const button = $("#player-queue-toggle");
    if (!panel || !button) return;
    const transitionId = ++queuePanelTransitionId;
    if (queuePanelCloseTimer) {
      clearTimeout(queuePanelCloseTimer);
      queuePanelCloseTimer = 0;
    }
    if (open) {
      panel.classList.remove("queue-closing", "queue-opening");
      panel.hidden = false;
      void panel.offsetWidth;
      panel.classList.add("queue-opening");
      button.setAttribute("aria-expanded", "true");
      renderPlayerQueue({focusCurrent:true});
      panel.addEventListener("animationend", event => {
        if (transitionId === queuePanelTransitionId && event.target === panel && event.animationName === "player-queue-enter") {
          panel.classList.remove("queue-opening");
        }
      }, { once: true });
      return;
    }
    if (panel.hidden) {
      button.setAttribute("aria-expanded", "false");
      return;
    }
    panel.classList.remove("queue-opening");
    panel.classList.add("queue-closing");
    button.setAttribute("aria-expanded", "false");
    const finish = () => {
      if (transitionId !== queuePanelTransitionId) return;
      panel.hidden = true;
      panel.classList.remove("queue-closing");
      queuePanelCloseTimer = 0;
      if (restoreFocus) button.focus({ preventScroll: true });
    };
    panel.addEventListener("animationend", event => {
      if (event.target === panel && event.animationName === "player-queue-exit") finish();
    }, { once: true });
    queuePanelCloseTimer = setTimeout(finish, 360);
  }
  $("#player-queue-toggle")?.addEventListener("click",()=>{
    const panel=$("#player-queue-panel");
    if(!panel)return;
    const isOpen=!panel.hidden&&!panel.classList.contains("queue-closing");
    setPlayerQueueOpen(!isOpen);
  });
  $("#player-queue-close")?.addEventListener("click",()=>{
    setPlayerQueueOpen(false,true);
  });
  $("#player-queue-list")?.addEventListener("click",event=>{
    const row=event.target.closest("[data-queue-index]");
    if(!row)return;
    const targetIndex=Number(row.dataset.queueIndex);
    if(!Number.isInteger(targetIndex)||targetIndex<0||targetIndex>=state.queue.length)return;
    const type=state.currentItem?.itemType||"track";
    if(targetIndex===state.queueIndex){
      if(state.restoredPlaybackPending)void playItem(type,state.queue[targetIndex],state.queue,targetIndex,{preserveQueue:true,restorePositionMs:state.restorePositionMs});
      return;
    }
    void playItem(type,state.queue[targetIndex],state.queue,targetIndex,{preserveQueue:true});
  });
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    const panel=$("#player-queue-panel");
    if(panel&&!panel.hidden){
      setPlayerQueueOpen(false,true);
    }
  });

  $("#lyrics-list")?.addEventListener("click",event=>{
    const line=event.target.closest("[data-lyric-index]");if(!line)return;
    const cue=state.lyricsCues[Number(line.dataset.lyricIndex)];
    if(cue&&Number.isFinite(cue.time)){audio.currentTime=cue.time;syncLyricsHighlight({forceScroll:true});}
  });

  window.setInterval(()=>{if(!state.currentItem||audio.paused)return;accountTime();persistSession(false);saveProgress(false);savePlaybackPosition(true);timeline();},15000);
  window.addEventListener("pagehide",()=>{accountTime();persistSession(false);saveProgress(true);savePlaybackPosition(true);savePlaybackQueueState();});
  async function showView(name){
    const target=name==="podcasts"?"shows":name;
    if(target==="now-playing"&&!state.currentItem){message("請先從曲庫選擇音訊。");return;}
    const returningFromNowPlaying=state.view==="now-playing"&&target!=="now-playing";
    if(target!=="now-playing")state.lastLibraryView=target;
    if(target==="folders")state.selectedFolder=null;
    if(target==="playlists")state.selectedPlaylistId="";
    state.view=target;
    if(target!=="now-playing"&&!returningFromNowPlaying)state.search="";
    if(returningFromNowPlaying){render();return;}
    if(!state.loaded)await load(true);else render();
  }
  async function refresh(){state.loaded=false;await load(true);}
  loadUserPlaylists();
  loadPlayerPreferences();updatePlayerModeButton();updateShuffleButton();
  setDock(null);void showView("music");
  return {showView,refresh,load};
}
