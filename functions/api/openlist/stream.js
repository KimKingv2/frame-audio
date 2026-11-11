import { verifyStreamTicket } from "../../_lib/stream-ticket.js";

async function relay(request, env, method) {
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const target = await verifyStreamTicket(env, ticket);
  if (!target) return new Response("音訊串流授權已失效，請重新播放歌曲。", {
    status: 403,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
  });

  const range = request.headers.get("Range");
  if (range && !/^bytes=\d*-\d*(?:\s*,\s*\d*-\d*)*$/.test(range.trim())) {
    return new Response("Invalid Range header.", { status: 416, headers: { "Cache-Control": "no-store" } });
  }

  const requestHeaders = new Headers();
  if (range) requestHeaders.set("Range", range);
  const ifRange = request.headers.get("If-Range");
  if (ifRange) requestHeaders.set("If-Range", ifRange);

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers: requestHeaders,
      redirect: "follow"
    });
  } catch {
    return new Response("上游音訊來源暫時無法連接。", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  if (!upstream.ok && upstream.status !== 416) {
    try { await upstream.body?.cancel(); } catch {}
    return new Response("上游音訊來源回應異常（HTTP " + upstream.status + "）。", {
      status: 502,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified"
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("accept-ranges") && upstream.status === 206) {
    headers.set("Accept-Ranges", "bytes");
  }
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Access-Control-Allow-Origin", new URL(request.url).origin);
  headers.set("Vary", "Origin");

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers
  });
}

export async function onRequestGet({ request, env }) {
  return relay(request, env, "GET");
}

export async function onRequestHead({ request, env }) {
  return relay(request, env, "HEAD");
}
