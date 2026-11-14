function environmentProfiles(env) {
  return {
    vps: {
      baseUrl: String(env.ALIST_VPS_API_BASE_URL || env.OPENLIST_BASE_URL || "").trim(),
      username: String(env.ALIST_VPS_USERNAME || "").trim(),
      password: String(env.ALIST_VPS_PASSWORD || "")
    },
    worker: {
      baseUrl: String(env.OPENLIST_WORKER_API_BASE_URL || env.ALIST_WORKER_API_BASE_URL || "").trim(),
      username: String(env.OPENLIST_WORKER_USERNAME || "").trim(),
      password: String(env.OPENLIST_WORKER_PASSWORD || "")
    },
    "mobile-device": {
      baseUrl: String(env.ALIST_MOBILE_DEVICE_API_BASE_URL || "").trim(),
      username: String(env.ALIST_MOBILE_DEVICE_USERNAME || "").trim(),
      password: String(env.ALIST_MOBILE_DEVICE_PASSWORD || "")
    }
  };
}

export async function readConnectionProfiles(env) {
  return { profiles: environmentProfiles(env) };
}

export function publicConnectionProfiles(profiles) {
  const output = {};
  for (const name of ["vps", "worker", "mobile-device"]) {
    const profile = profiles?.[name] || {};
    const baseUrl = String(profile.baseUrl || "");
    const hasCredentials = Boolean(String(profile.username || "").trim() && String(profile.password || ""));
    output[name] = {
      baseUrl,
      hasCredentials,
      authMode: hasCredentials ? "automatic-login" : "missing",
      configured: Boolean(baseUrl && hasCredentials)
    };
  }
  return output;
}
