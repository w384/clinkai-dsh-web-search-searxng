import z from "@deepseek-ai/schemastery";
import { WebError } from "@deepseek-ai/dsh-web";

/**
 * SearXNG-backed search provider for the DeepSeek Harness web capability seam
 * (`ctx.web.registerSearchProvider`). SearXNG is a self-hosted metasearch
 * engine with a plain `format=json` API, so this provider needs no API key and
 * no per-call billing: it is the free, always-on alternative to the official
 * DeepSeek-backed provider.
 *
 * DSH version independence: this is a separate package that plugs into the
 * stable `@deepseek-ai/dsh-web` seam via `inject: ["web"]`. It never patches
 * DSH source, so a DSH upgrade overwrites nothing here as long as the seam's
 * `WebSearchProvider` contract stays in the peer range above.
 */

/** Cordis plugin name (used by loader diagnostics). */
const name = "web-search-searxng";

/** The web seam this provider registers into. */
const inject = ["web"];

/** Stable provider id registered with `ctx.web`; pin it via `web.searchProvider`. */
const SEARXNG_PROVIDER_ID = "searxng";

const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT_MS = 15000;
const USER_AGENT = "dsh-web-search-searxng/0.1.0";

/** Configuration schema; values come from the loader patch row, defaults here. */
const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().step(1).min(500).default(DEFAULT_TIMEOUT_MS)
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

/** Register the SearXNG provider with `ctx.web`. */
function apply(ctx, config) {
  ctx.web.registerSearchProvider(new SearXNGSearchProvider(() => config));
}

export {
  Config,
  SEARXNG_PROVIDER_ID,
  SearXNGSearchProvider,
  apply,
  inject,
  name
};