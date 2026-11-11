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
    return "";
  }).filter(Boolean).join("\n");
  const cues = [];
  const plainLines = [];
  const timestampPattern = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g;
  const metadataPattern = /^\[(?:ar|al|ti|by|re|ve|length|offset):/i;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const matches = [...line.matchAll(timestampPattern)];
    if (matches.length) {
      const lyricText = line.replace(timestampPattern, "").trim();
      if (!lyricText) continue;
      for (const match of matches) {
        const fractionText = match[3] || "0";
        const fraction = Number(fractionText.padEnd(3, "0").slice(0, 3)) / 1000;
        const time = Number(match[1]) * 60 + Number(match[2]) + fraction;
        cues.push({time,text:lyricText});
      }
    } else if (!metadataPattern.test(line) && !/^\[(?:\d{1,3}:)?\d{1,3}\]$/.test(line)) {
      plainLines.push(line);
    }
  }
  cues.sort((a,b) => a.time-b.time);
  return {cues,plainLines};
}
