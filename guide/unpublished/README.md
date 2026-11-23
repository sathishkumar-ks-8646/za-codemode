# Unpublished chapters

Pages that are written but deliberately **not** part of the published guide.
`build.py` does not know about them: they are absent from `PAGES`, so they are
neither rendered nor linked, and `--check` does not validate them.

| Page | Why it is held back |
|---|---|
| `07-remote-deployment.md` | Remote (multi-user HTTP) mode is implemented in `src/remote/` and covered by `test/remote.test.mjs`, but it is not released. Documenting it would invite deployments the write path and per-user rate limiting are not ready for. |

## Publishing one

1. Move the `.md` back to `guide/`.
2. Add its stem to `PAGES` in `build.py`, in navigation order.
3. Restore the inbound links that referred to it — `git log -- guide/unpublished`
   shows which pages carried them.
4. Re-render: `cd guide && python3 build.py`, then commit the `.html` alongside
   the `.md`.

The stale `.html` sibling is kept here only so the move is reversible in one
step. Never link to it; re-render instead.
