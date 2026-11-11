export const EQ_BANDS = Object.freeze([
  {frequency:55,label:"55",shortLabel:"55"},
  {frequency:77,label:"77",shortLabel:"77"},
  {frequency:110,label:"110",shortLabel:"110"},
  {frequency:156,label:"156",shortLabel:"156"},
  {frequency:220,label:"220",shortLabel:"220"},
  {frequency:311,label:"311",shortLabel:"311"},
  {frequency:440,label:"440",shortLabel:"440"},
  {frequency:622,label:"622",shortLabel:"622"},
  {frequency:880,label:"880",shortLabel:"880"},
  {frequency:1200,label:"1.2k",shortLabel:"1.2k"},
  {frequency:1800,label:"1.8k",shortLabel:"1.8k"},
  {frequency:2500,label:"2.5k",shortLabel:"2.5k"},
  {frequency:3500,label:"3.5k",shortLabel:"3.5k"},
  {frequency:5000,label:"5k",shortLabel:"5k"},
  {frequency:7000,label:"7k",shortLabel:"7k"},
  {frequency:10000,label:"10k",shortLabel:"10k"},
  {frequency:14000,label:"14k",shortLabel:"14k"},
  {frequency:20000,label:"20k",shortLabel:"20k"}
]);

export function parseFoobarFeq(input) {
  const lines = String(input ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 18) {
    throw new Error("foobar2000 .feq 必須包含 18 個非空白數值行；目前只有 " + lines.length + " 行。");
  }
  return lines.slice(0, 18).map((line, index) => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(line)) {
      throw new Error(".feq 第 " + (index + 1) + " 個頻段不是有效數值。");
    }
    const value = Number(line);
    if (!Number.isFinite(value) || value < -20 || value > 20) {
      throw new Error(".feq 第 " + (index + 1) + " 個頻段超出 -20 至 +20 dB 範圍。");
    }
    return Math.round(value * 10) / 10;
  });
}

export function parseSynchronizedLyrics(input) {
  const sources = Array.isArray(input) ? input.flat(Infinity) : input == null ? [] : [input];
  const parseClock = value => {
    const match = String(value).trim().replace(",", ".").match(/^(?:(\d{1,3}):)?(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/);
    if (!match) return NaN;
    return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 +
      Number(match[3] || 0) + (match[4] ? Number("0." + match[4]) : 0);
  };
  const objectTime = (cue, parent = {}) => {
    if (cue.timeMs != null) return Number(cue.timeMs) / 1000;
    if (cue.timestampMs != null) return Number(cue.timestampMs) / 1000;
    if (cue.startTimeMs != null) return Number(cue.startTimeMs) / 1000;
    const raw = cue.timestamp ?? cue.time ?? cue.startTime;
    const format = String(parent.timeStampFormat ?? parent.timestampFormat ?? "").toLowerCase();
    const isMilliseconds = format === "2" || format === "ms" ||
      format.includes("millisecond");
    const isFrames = format === "1" || format.includes("frame");
    if (typeof raw === "string" && /:/.test(raw)) return parseClock(raw);
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return NaN;
    if (isMilliseconds) return numeric / 1000;
    if (isFrames) return numeric * (1152 / Number(parent.sampleRate || 44100));
    return Math.abs(numeric) >= 1000 ? numeric / 1000 : numeric;
  };
  const formatLrc = (seconds, text) => {
    if (!Number.isFinite(seconds) || typeof text !== "string" || !text.trim()) return "";
    const safe = Math.max(0, seconds), minutes = Math.floor(safe / 60);
    const remainder = (safe % 60).toFixed(3).padStart(6, "0");
    return "[" + String(minutes).padStart(2, "0") + ":" + remainder + "]" + text.trim();
  };
  const sourceText = sources.map(value => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const cueList = Array.isArray(value.cues) ? value.cues :
      Array.isArray(value.syncText) ? value.syncText :
      Array.isArray(value.synchronizedText) ? value.synchronizedText : null;
    if (cueList) return cueList.map(cue =>
      formatLrc(objectTime(cue, value), cue.text ?? cue.words ?? cue.content)
    ).filter(Boolean).join("\n");
    if (typeof value.text === "string") return value.text;
    if (typeof value.value === "string") return value.value;
    if (typeof value.lyrics === "string") return value.lyrics;
    return "";
  }).filter(Boolean).join("\n").replace(/^\uFEFF/, "");

  const cues = [], plainLines = [];
  const marker = /[\[<({]((?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)[\]>)}]/g;
  const bare = /^((?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)(?:\s*(?:-->|[-|])\s*|\s+)(.+)$/;
  const lone = /^\[?((?:\d{1,3}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)\]?$/;
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n");
  let offsetSeconds = 0;
  for (const line of lines) {
    const match = line.trim().match(/^\[offset:([+-]?\d+)\]$/i);
    if (match) offsetSeconds = Number(match[1]) / 1000;
  }
  const addCue = (rawTime, rawText) => {
    const time = parseClock(rawTime);
    const text = String(rawText || "").replace(/^(?:v\d+:)+/i, "")
      .replace(/^[\s,;|]+|[\s,;|]+$/g, "").trim();
    if (Number.isFinite(time) && text) cues.push({time:Math.max(0,time+offsetSeconds),text});
  };
  for (let index=0; index<lines.length; index+=1) {
    const line=lines[index].trim();
    if (!line || /^\[offset:[+-]?\d+\]$/i.test(line) || /^\[(?:ar|al|ti|by|re|ve|length):/i.test(line)) continue;
    const range=line.match(/^((?:\d{1,3}:)?\d{1,3}:[0-5]\d[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,3}:[0-5]\d[.,]\d{1,3})(?:\s+.*)?$/);
    if (range) {
      let next=index+1;
      while(next<lines.length&&(!lines[next].trim()||/^\d+$/.test(lines[next].trim())))next+=1;
      if(next<lines.length){addCue(range[1],lines[next]);index=next;continue;}
    }
    const matches=[...line.matchAll(marker)];
    if(matches.length){
      const segments=matches.map((match,i)=>{
        const start=match.index+match[0].length,end=i+1<matches.length?matches[i+1].index:line.length;
        return line.slice(start,end).replace(/^[\s,;|]+|[\s,;|]+$/g,"").trim();
      });
      const nonEmpty=segments.filter(Boolean);
      if(matches.length>1&&nonEmpty.length===1&&segments.slice(0,-1).every(x=>!x))matches.forEach(match=>addCue(match[1],nonEmpty[0]));
      else matches.forEach((match,i)=>addCue(match[1],segments[i]));
      continue;
    }
    const bareMatch=line.match(bare);
    if(bareMatch){addCue(bareMatch[1],bareMatch[2]);continue;}
    const loneMatch=line.match(lone);
    if(loneMatch){
      let next=index+1;
      while(next<lines.length&&(!lines[next].trim()||/^\d+$/.test(lines[next].trim())))next+=1;
      if(next<lines.length){addCue(loneMatch[1],lines[next]);index=next;}
      continue;
    }
    if(!/^\d+$/.test(line))plainLines.push(line.replace(/^(?:v\d+:)+/i,"").trim());
  }
  cues.sort((a,b)=>a.time-b.time);
  const unique=cues.filter((cue,i)=>i===0||cue.time!==cues[i-1].time||cue.text!==cues[i-1].text);
  return {cues:unique,plainLines};
}
