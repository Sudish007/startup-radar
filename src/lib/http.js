export class HttpError extends Error {
  constructor(status, url, message) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_UA = 'StartupRadar/1.0 (+http://localhost:3000)';

/**
 * Fetch a URL as text with a User-Agent, timeout and body-size cap.
 * Throws HttpError for non-2xx responses or oversized bodies.
 */
export async function fetchText(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 15000,
  signal,
  userAgent = DEFAULT_UA,
  maxBytes = 5_000_000,
} = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': userAgent, Accept: '*/*', ...headers },
    body,
    signal: merged,
    redirect: 'follow',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}`);
  }
  if (text.length > maxBytes) {
    throw new HttpError(res.status, url, `response too large (${text.length} chars > ${maxBytes}) for ${url}`);
  }
  return { status: res.status, text, headers: res.headers, url: res.url };
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  return JSON.parse(res.text);
}

/** Bind config (userAgent, timeout, size cap) and return the two helpers. */
export function createHttp(config) {
  const defaults = {
    userAgent: config.userAgent,
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxBodyBytes,
  };
  return {
    fetchText: (url, opts = {}) => fetchText(url, { ...defaults, ...opts }),
    fetchJson: (url, opts = {}) => fetchJson(url, { ...defaults, ...opts }),
  };
}
