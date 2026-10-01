import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * SearXNG-backed search provider for the DeepSeek Harness web capability seam
 * (`ctx.web`), with an optional automatic fallback to another provider — by
 * default the built-in DeepSeek search — when SearXNG is unreachable.
 *
 * One package registers two providers on the public seam:
 *
 *   searxng          pure SearXNG (`GET {baseUrl}/search?format=json`)
 *   search-fallback  SearXNG first; on a connect failure, an internal timeout or
 *                    an HTTP 5xx it retries through `fallbackProvider`
 *
 * Pin the seam with `web.searchProvider` to either id. Nothing here imports a
 * DSH-internal export or patches DSH source: both providers are reached through
 * the public provider registry, so a DSH upgrade overwrites nothing.
 */

/** Cordis plugin name (loader diagnostics). */
const name = "@clinkai/dsh-web-search-searxng";

/** The web seam these providers register into. */
const inject = ["web"];

/** Pure SearXNG provider id. */
const SEARXNG_PROVIDER_ID = "searxng";
/** Dispatcher provider id (SearXNG first, then the fallback provider). */
const DISPATCH_PROVIDER_ID = "search-fallback";

/** Provider the dispatcher falls back to when the primary is unusable. */
const DEFAULT_FALLBACK_PROVIDER_ID = "deepseek-official";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = "@clinkai/dsh-web-search-searxng/0.2.0";

/** Configuration schema; values come from the loader patch row, defaults here. */
const Config = z.object({
  /** SearXNG origin. Note DSH's own Web GUI defaults to 127.0.0.1:8080. */
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  /** Per-request timeout for the SearXNG call. */
  timeoutMs: z.number().step(1).min(500).default(DEFAULT_TIMEOUT_MS),
  /** Register the dispatcher provider as well as the pure one. */
  fallbackEnabled: z.boolean().default(true),
  /** Provider id the dispatcher retries through. */
  fallbackProvider: z.string().default(DEFAULT_FALLBACK_PROVIDER_ID),
  /** Treat an empty SearXNG result as a failure worth retrying. */
  fallbackOnEmpty: z.boolean().default(false),
});

/** True for a fetch/AbortSignal abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Map a SearXNG `format=json` response to the normalized search result.
 * `results[].{url,title,content,publishedDate}` become citeable sources;
 * the top-level `answers[0].answer` (instant answer) becomes `content` when
 * present. The seam owns final `maxResults` truncation, so `truncated` is
 * always false here.
 */
function mapSearxngResponse(data) {
  const seen = /* @__PURE__ */ new Set();
  const sources = [];
  for (const item of data?.results ?? []) {
    const url = item?.url;
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      ...(typeof item.title === "string" && item.title.length > 0 ? { title: item.title } : {}),
      ...(typeof item.content === "string" && item.content.length > 0 ? { snippet: item.content } : {}),
      ...(typeof item.publishedDate === "string" && item.publishedDate.length > 0 ? { publishedAt: item.publishedDate } : {})
    });
  }
  const firstAnswer = (data?.answers ?? [])[0];
  const content = typeof firstAnswer?.answer === "string" && firstAnswer.answer.trim().length > 0 ? firstAnswer.answer.trim() : void 0;
  return {
    ...(content !== void 0 ? { content } : {}),
    sources,
    truncated: false
  };
}

/**
 * The SearXNG search provider. Calls `GET {baseUrl}/search?q=...&format=json`.
 * `available()` is a cheap local check (the base URL parses) and never touches
 * the network, per the seam contract.
 */
class SearXNGSearchProvider {
  resolveOptions;
  id = SEARXNG_PROVIDER_ID;

  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  available() {
    const { baseUrl } = this.resolveOptions();
    return typeof baseUrl === "string" && baseUrl.trim().length > 0 && typeof URL !== "undefined" && URL.canParse(baseUrl);
  }

  async search(request, signal) {
    const { baseUrl, timeoutMs } = this.resolveOptions();
    const endpoint = new URL(baseUrl.trim().replace(/\/+$/, "") + "/search");
    endpoint.searchParams.set("q", request.query);
    endpoint.searchParams.set("format", "json");

    const signals = [signal, AbortSignal.timeout(timeoutMs)].filter(Boolean);
    const combined = AbortSignal.any(signals);

    let response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT
        },
        signal: combined
      });
    } catch (error) {
      if (combined.aborted) throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
      throw new WebError(`SearXNG search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (!response.ok) {
      throw new WebError(`SearXNG error (HTTP ${response.status}) — is the SearXNG service running at ${endpoint.origin}?`, "WEB_PROVIDER_ERROR");
    }
    try {
      return mapSearxngResponse(await response.json());
    } catch (error) {
      if (combined.aborted) throw new WebError("SearXNG search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
      throw new WebError(`SearXNG returned an unprocessable response: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }
}

/**
 * Connection-level failure codes that mean the backend host itself could not be
 * reached (Docker/SearXNG down), as opposed to a target-side or response-level
 * failure, which the fallback must not mask.
 */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

/** Walk the full `cause` chain looking for a connect-level failure code. */
function isConnectError(error) {
  const seen = /* @__PURE__ */ new Set();
  for (let current = error; current !== null && current !== void 0; ) {
    if (typeof current === "object" && typeof current.code === "string" && CONNECT_ERROR_CODES.has(current.code)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = typeof current === "object" ? current.cause : null;
  }
  return false;
}

/**
 * Whether a primary-provider failure means the backend is "unavailable" and the
 * request should be retried through the fallback provider. A caller
 * cancellation or a target-side 4xx is NOT a fallback trigger.
 */
function shouldFallback(error, signal) {
  // 1. The SearXNG host itself could not be reached (Docker down):
  //    ECONNREFUSED / ETIMEDOUT / ENOTFOUND / ... — walk the whole cause chain.
  if (isConnectError(error)) return true;
  if (error instanceof WebError) {
    // 2. Internal timeout while the caller did NOT cancel: SearXNG hung.
    if (error.code === "WEB_ABORTED" && signal?.aborted !== true) return true;
    // 3. SearXNG answered with a server error: service up but broken.
    if (error.code === "WEB_PROVIDER_ERROR" && /HTTP [5-9]\d\d/.test(error.message)) return true;
  }
  return false;
}

/**
 * The dispatcher provider: SearXNG first, then `fallbackProvider` when the
 * primary is unreachable, times out, fails with an HTTP 5xx, or (only when
 * `fallbackOnEmpty` is set) returns nothing. It reads both providers from the
 * seam registry at call time, so it needs no import of either one.
 */
class SearchDispatcherProvider {
  ctx;
  id = DISPATCH_PROVIDER_ID;

  constructor(ctx, resolveOptions) {
    this.ctx = ctx;
    this.resolveOptions = resolveOptions;
  }

  provider(id) {
    return this.ctx.web.searchProviders.get(id);
  }

  fallback() {
    const { fallbackEnabled, fallbackProvider } = this.resolveOptions();
    if (fallbackEnabled === false) return void 0;
    return this.provider(fallbackProvider ?? DEFAULT_FALLBACK_PROVIDER_ID);
  }

  available() {
    const primary = this.provider(SEARXNG_PROVIDER_ID);
    const fallback = this.fallback();
    return primary?.available() === true || fallback?.available() === true;
  }

  async search(request, signal) {
    const primary = this.provider(SEARXNG_PROVIDER_ID);
    const fallback = this.fallback();
    // 配置可能未经 schema 解析（例如程序化 apply 传了部分字段），这里自行补默认值
    const fallbackOnEmpty = this.resolveOptions().fallbackOnEmpty === true;

    if (primary !== void 0) {
      try {
        const result = await primary.search(request, signal);
        const empty = (result?.sources?.length ?? 0) === 0;
        if (fallbackOnEmpty === true && empty && fallback !== void 0 && fallback.available()) {
          return await fallback.search(request, signal);
        }
        return result;
      } catch (error) {
        if (shouldFallback(error, signal) && fallback !== void 0 && fallback.available()) {
          return await fallback.search(request, signal);
        }
        throw error;
      }
    }
    if (fallback !== void 0 && fallback.available()) {
      return await fallback.search(request, signal);
    }
    throw new WebError("no usable web search provider is registered", "WEB_PROVIDER_UNAVAILABLE");
  }
}

/** Register both providers with `ctx.web`. */
function apply(ctx, config) {
  ctx.web.registerSearchProvider(new SearXNGSearchProvider(() => config));
  ctx.web.registerSearchProvider(new SearchDispatcherProvider(ctx, () => config));
}

export {
  Config,
  DISPATCH_PROVIDER_ID,
  DEFAULT_FALLBACK_PROVIDER_ID,
  SEARXNG_PROVIDER_ID,
  SearchDispatcherProvider,
  SearXNGSearchProvider,
  apply,
  inject,
  isAbortError,
  isConnectError,
  mapSearxngResponse,
  name,
  shouldFallback
};
