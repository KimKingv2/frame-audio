function environmentProfiles(env) {
  return {
    vps: {
      baseUrl: String(env.ALIST_VPS_API_BASE_URL || env.OPENLIST_BASE_URL || "").trim(),
      token: String(env.ALIST_VPS_API_TOKEN || env.OPENLIST_API_TOKEN || "").trim()
    },
    worker: {
      baseUrl: String(env.OPENLIST_WORKER_API_BASE_URL || env.ALIST_WORKER_API_BASE_URL || "").trim(),
      token: String(env.OPENLIST_WORKER_API_TOKEN || env.ALIST_WORKER_API_TOKEN || "").trim()
    }
  };
}

// Server credentials are provisioned only through Cloudflare Pages Variables
// and Secrets. They are never written to D1 or returned to the browser.
export async function readConnectionProfiles(env) {
  return { profiles: environmentProfiles(env) };
}

export function publicConnectionProfiles(profiles) {
  const output = {};
  for (const name of ["vps", "worker"]) {
    const profile = profiles?.[name] || {};
    const baseUrl = String(profile.baseUrl || "");
    const hasToken = Boolean(String(profile.token || ""));
    output[name] = { baseUrl, hasToken, configured: Boolean(baseUrl && hasToken) };
  }
  return output;
}
