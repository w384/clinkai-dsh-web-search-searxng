# @clinkai/dsh-web-search-searxng

A **SearXNG**-backed `web_search` provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web capability seam (`ctx.web`) — with **automatic fallback to another provider** (by default the built-in DeepSeek search) when SearXNG is unreachable.

One package, two providers on the public seam:

| provider id | behaviour |
|---|---|
| `searxng` | pure SearXNG: `GET {baseUrl}/search?q=<query>&format=json` |
| `search-fallback` | SearXNG first; retries through `fallbackProvider` when the backend is down, hangs, answers 5xx, or (opt-in) returns nothing |

Pin the seam to whichever one you want with `web.searchProvider`. Nothing here patches DSH source or imports a DSH-internal export, so a DSH upgrade overwrites nothing.

- **No API key, no billing** — SearXNG aggregates many engines for free.
- **Never leaves search broken** — if Docker/SearXNG is down, `search-fallback` transparently uses the built-in DeepSeek search.

## Run SearXNG

SearXNG has no native Windows support, so run it with Docker (`docker compose up -d`):

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    container_name: searxng
    ports:
      - "127.0.0.1:18081:8080"   # 8080 is usually taken by the DSH Web GUI
    volumes:
      - ./config:/etc/searxng:rw
    restart: unless-stopped
```

Make sure `format=json` is enabled in `config/settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

### Engine notes (measured, not guessed)

- **Domestic engines are off by default.** `sogou` and `360search` answer fine without any proxy, but SearXNG ships them `disabled`; enable them explicitly or a default search returns nothing while the reachable engines are all blocked ones.
- **`google` works** whenever the host tunnel is up (or when you point the engine at a local proxy, see below); it periodically gets CAPTCHA-suspended on a shared VPN exit and recovers by itself.
- **`brave` (HTTP 429), `duckduckgo` and `quark` (CAPTCHA)** are bot-blocked — a proxy does not fix that.
- An engine that failed while DNS/tunnel was not ready is marked *Suspended* by SearXNG for a while; restart the container before concluding "it cannot connect".

Per-engine proxy (keep domestic engines direct, send only the blocked ones through a local proxy client):

```yaml
engines:
  - name: sogou
    disabled: false
  - name: google
    disabled: false
    proxies:
      all://:
        - http://host.docker.internal:12000
    timeout: 8.0
```

## Install

The package ships a `dsh.bundle.patch`, so installing it is enough: DSH mounts the
providers as a bundle layer and there is nothing to hand-wire.

```sh
# from npm (once published)
dsh plugin --profile web add @clinkai/dsh-web-search-searxng

# straight from GitHub — no registry needed, the built entry is committed
dsh plugin --profile web add github:w384/clinkai-dsh-web-search-searxng

# from a local checkout, or from a packed tarball
dsh plugin --profile web add link:/path/to/clinkai-dsh-web-search-searxng
dsh plugin --profile web add ./clinkai-dsh-web-search-searxng-0.2.0.tgz
```

Override the row by id to pin this instance's SearXNG origin, and point the seam at
one of the two providers. In `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: web-search-searxng
  config:
    baseUrl: http://127.0.0.1:18081
    fallbackOnEmpty: true
- id: web
  config:
    searchProvider: search-fallback   # or: searxng
```

## Config

| key | default | meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8080` | SearXNG origin |
| `timeoutMs` | `15000` | per-request timeout for the SearXNG call |
| `fallbackEnabled` | `true` | register the `search-fallback` provider |
| `fallbackProvider` | `deepseek-official` | provider id the dispatcher retries through |
| `fallbackOnEmpty` | `false` | treat an empty SearXNG result as a failure and retry the fallback |

## When it falls back

- **Connection-level failure** — Docker / SearXNG is down (`ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` …; walks the full `cause` chain).
- **Timeout** — SearXNG hung and the caller did not cancel.
- **HTTP 5xx** — SearXNG is up but failing.
- **Empty result** — only when `fallbackOnEmpty: true`.

Anything else (a caller cancellation, a 4xx like a bad request) is passed through unchanged.
The `searxng` and `deepseek-official` providers must both stay registered — their own plugins —
because the dispatcher reads them from the seam registry at call time.

## Troubleshooting

- **Port 8080 conflict** — the DSH Web GUI itself binds `127.0.0.1:8080` by default, so a SearXNG port mapping on 8080 silently fails (the container runs but is unreachable). Use a different host port (e.g. `18081`) and set `baseUrl` accordingly.
- **Windows reserved port ranges** — Hyper-V/WSL NAT reserves ranges (e.g. `8804-8903`), and binding inside one fails with `bind: An attempt was made to access a socket in a way forbidden by its access permissions` even though nothing listens. Check with `netsh interface ipv4 show excludedportrange protocol=tcp`.

## License

MIT
