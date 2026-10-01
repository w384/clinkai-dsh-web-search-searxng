# @clinkai/dsh-web-search-searxng

A **SearXNG**-backed `web_search` provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web capability seam (`ctx.web`).

It plugs into the same seam as the official `@deepseek-ai/dsh-web-search-deepseek` provider, but instead of calling the DeepSeek API it calls a self-hosted [SearXNG](https://github.com/searxng/searxng) instance's JSON endpoint:

```
GET {baseUrl}/search?q=<query>&format=json
```

- **No API key, no billing, no rate limit** — SearXNG aggregates many engines for free.
- **DSH-upgrade proof** — a standalone npm package over the stable `WebSearchProvider` interface; it never patches DSH source.

## Run SearXNG

SearXNG has no native Windows support, so run it with Docker (`docker compose up -d`):

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "127.0.0.1:18081:8080"
    volumes:
      - ./config:/etc/searxng:rw
    restart: unless-stopped
```

Make sure `format=json` is enabled in SearXNG's `config/settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## Install

Then install this provider into a DSH profile:

```sh
dsh plugin --profile web add @clinkai/dsh-web-search-searxng   # from npm (once published)
# or, from a local/git source:
dsh plugin --profile web add "link:/path/to/clinkai-dsh-web-search-searxng"
```

Installing the package is enough: it ships a `dsh.bundle.patch`, so DSH mounts the
provider as a bundle layer. Override the row by id only to pin this instance's
SearXNG origin, and point the seam at the provider. In
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: web-search-searxng
  config:
    baseUrl: http://127.0.0.1:18081
- id: web
  config:
    searchProvider: searxng
```

## Config

| key        | default                   | meaning                          |
|------------|---------------------------|----------------------------------|
| `baseUrl`  | `http://127.0.0.1:8080`   | SearXNG origin                    |
| `timeoutMs`| `15000`                   | per-request timeout               |

## Troubleshooting

- **Port 8080 conflict** — the DSH web GUI itself binds `127.0.0.1:8080` by default, so a SearXNG port mapping on 8080 silently fails (the container runs but is unreachable). Use a different host port (e.g. `18081`) and set `baseUrl` accordingly.
- **Windows reserved port ranges** — Hyper-V/WSL NAT reserves ranges (e.g. `8804-8903`), and binding inside one fails with `bind: An attempt was made to access a socket in a way forbidden by its access permissions` even though nothing listens. Check with `netsh interface ipv4 show excludedportrange protocol=tcp`.

## License

MIT