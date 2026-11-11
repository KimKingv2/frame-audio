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
  const sources = Array.isArray(input) ? input : input == null ? [] : [input];
  const text = sources.map(value => {
    if (typeof value === "string") return value;
    if (value && typeof value.text === "string") return value.text;
    if (value && Array.isArray(value.cues)) {
      return value.cues.map(cue => {
        const milliseconds = Number(cue.timeMs ?? cue.timestampMs ?? cue.time);
        const seconds = Number.isFinite(milliseconds)
          ? (milliseconds > 10000 ? milliseconds / 1000 : milliseconds)
          : NaN;
        if (!Number.isFinite(seconds) || typeof cue.text !== "string") return "";
        const minutes = Math.floor(seconds / 60);
        const remainder = (seconds % 60).toFixed(3).padStart(6, "0");
        return "[" + String(minutes).padStart(2, "0") + ":" + remainder + "]" + cue.text;
      }).filter(Boolean).join("\n");
    }
    return "";
  }).filter(Boolean).join("\n").replace(/^\uFEFF/, "");
  const cues = [];
  const plainLines = [];
  const timestampPattern = /[\[<{]((?:\d{1,2}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)[\]}>]/g;
  const bareTimestampPattern = /^((?:\d{1,2}:)?\d{1,3}:[0-5]\d(?:[.,]\d{1,3})?)(?:\s*[-|]\s*|\s+)(.+)$/;
  const metadataPattern = /^\[(?:ar|al|ti|by|re|ve|length):/i;
  let offsetSeconds = 0;
  const parseTime = value => {
    const [clock, fractionText = ""] = String(value).replace(",", ".").split(".");
    const parts = clock.split(":").map(Number);
    if (parts.some(part => !Number.isFinite(part))) return NaN;
    const fraction = fractionText ? Number("0." + fractionText) : 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1] + fraction;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2] + fraction;
    return NaN;
  };
  const addCue = (rawTime, lyricText) => {
    const time = parseTime(rawTime);
    const value = String(lyricText || "").replace(/^[\s,;|]+|[\s,;|]+$/g, "").trim();
    if (Number.isFinite(time) && value) cues.push({ time: Math.max(0, time + offsetSeconds), text: value });
  };
  const lines = text.replace(/\r/g, "\n").split(/\n+/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const offsetMatch = line.match(/^\[offset:([+-]?\d+)\]$/i);
    if (offsetMatch) {
      offsetSeconds = Number(offsetMatch[1]) / 1000;
      continue;
    }
    if (metadataPattern.test(line)) continue;

    const subtitleRange = line.match(/^((?:\d{1,2}:)?\d{1,3}:[0-5]\d[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,3}:[0-5]\d[.,]\d{1,3})$/);
    if (subtitleRange) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && !/^\d+$/.test(lines[next].trim())) {
        addCue(subtitleRange[1], lines[next]);
        index = next;
        continue;
      }
    }

    const matches = [...line.matchAll(timestampPattern)];
    if (matches.length) {
      const segments = matches.map((match, cueIndex) => {
        const start = match.index + match[0].length;
        const end = cueIndex + 1 < matches.length ? matches[cueIndex + 1].index : line.length;
        return line.slice(start, end).replace(/^[\s,;|]+|[\s,;|]+$/g, "").trim();
      });
      const nonEmpty = segments.filter(Boolean);
      if (matches.length > 1 && nonEmpty.length === 1 && segments.slice(0, -1).every(value => !value)) {
        matches.forEach(match => addCue(match[1], nonEmpty[0]));
      } else {
        matches.forEach((match, cueIndex) => addCue(match[1], segments[cueIndex]));
      }
      continue;
    }

    const bareMatch = line.match(bareTimestampPattern);
    if (bareMatch) {
      addCue(bareMatch[1], bareMatch[2]);
      continue;
    }
    if (!/^\[(?:\d{1,3}:)?\d{1,3}\]$/.test(line)) plainLines.push(line);
  }
  cues.sort((a, b) => a.time - b.time);
  return { cues, plainLines };
}
