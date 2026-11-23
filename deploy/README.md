# deploy/ — unreleased

Everything here serves the **multi-user HTTP server** (`src/remote.mjs`), which
is built and tested but **not released**. None of it is needed to run the
product: the shipped server speaks MCP over stdio, is installed from a clone,
and is spawned by the agent host. There is no image to build and no port to
open.

:warning: **Do not deploy this.** The write path is lightly tested and there is
no per-user rate limiting, which is exactly what a shared instance needs. It
lives here so it is not lost, not because it is ready.

| File | What it is |
|---|---|
| `Dockerfile` | Builds the HTTP server. Two stages, so the C++ toolchain `isolated-vm` needs is not in the final image; runs as `node`, never root. |
| `Dockerfile.dockerignore` | Build-context excludes. Named for the Dockerfile because the context is the repository root — BuildKit reads `<dockerfile>.dockerignore` in preference to the context's own. |
| `docker-compose.yml` | Reference deployment: the server plus Redis, so more than one replica can share sessions. |
| `.env.example` | Every variable the HTTP server reads, documented. Contains **no** variable the stdio server uses — those live in the keychain via `za-codemode login`. |

## Why these are not at the repository root

A root-level `docker-compose.yml` is an invitation: `docker compose up` is
reflex for anyone who finds one. That would stand up the unreleased
multi-user server, which is the one thing the README asks people not to do.
Moving it one directory down costs a `cd` and removes the reflex.

## The build context is the parent

The image needs `src/`, `manual/` and `knowledge/`, so the context is the
repository root and the Dockerfile is named explicitly:

```bash
# from the repository root
docker build -f deploy/Dockerfile -t za-codemode:remote .

# or from here, which compose already sets up
cd deploy && docker compose up --build
```

`env_file` resolves relative to this directory, so the compose file expects
`deploy/.env`. Copy `.env.example` to `.env` and fill it in — `.env` is
gitignored at any depth.

## Releasing it

1. Address the two blockers above: cover the write path, add per-user rate
   limiting of Analytics calls.
2. Move `guide/unpublished/07-remote-deployment.md` back into `guide/` and add
   its stem to `PAGES` in `guide/build.py` — see `guide/unpublished/README.md`.
3. Drop the UNRELEASED headers from the files here and this warning from the
   root `README.md`.
