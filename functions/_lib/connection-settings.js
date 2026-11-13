function environmentProfiles(env) {
  return {
    vps: {
      baseUrl: String(env.ALIST_VPS_API_BASE_URL || env.OPENLIST_BASE_URL || "").trim(),
      token: String(env.ALIST_VPS_API_TOKEN || env.OPENLIST_API_TOKEN || "").trim(),
      username: String(env.ALIST_VPS_USERNAME || "").trim(),
      password: String(env.ALIST_VPS_PASSWORD || "")
    },
    worker: {
      baseUrl: String(env.OPENLIST_WORKER_API_BASE_URL || env.ALIST_WORKER_API_BASE_URL || "").trim(),
      token: String(env.OPENLIST_WORKER_API_TOKEN || env.ALIST_WORKER_API_TOKEN || "").trim(),
      username: String(env.OPENLIST_WORKER_USERNAME || "").trim(),
      password: String(env.OPENLIST_WORKER_PASSWORD || "")
    },
    k40: {
      baseUrl: String(env.ALIST_K40_API_BASE_URL || "").trim(),
      token: String(env.ALIST_K40_API_TOKEN || "").trim(),
      username: String(env.ALIST_K40_USERNAME || "").trim(),
      password: String(env.ALIST_K40_PASSWORD || "")
    }
  };
}

export async function readConnectionProfiles(env) {
  return { profiles: environmentProfiles(env) };
}

export function publicConnectionProfiles(profiles) {
  const output = {};
  for (const name of ["vps", "worker", "k40"]) {
    const profile = profiles?.[name] || {};
    const baseUrl = String(profile.baseUrl || "");
    const hasCredentials = Boolean(String(profile.username || "").trim() && String(profile.password || ""));
    const hasLegacyToken = Boolean(String(profile.token || "").trim());
    output[name] = {
      baseUrl,
      hasToken: hasCredentials || hasLegacyToken,
      hasCredentials,
      authMode: hasCredentials ? "automatic-login" : hasLegacyToken ? "legacy-token" : "missing",
      configured: Boolean(baseUrl && (hasCredentials || hasLegacyToken))
    };
  }
  return output;
}
