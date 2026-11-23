# Licence

**Status: terms not yet approved. Do not redistribute.**

This repository holds the source code of **Zoho Analytics Code Mode** (`za-codemode`) —
an MCP server that executes sandboxed, model-written code against the Zoho Analytics
REST API. It is product source code, not documentation:

- the server itself, under `src/`;
- the build tools under `tools/`, which generate the two bundled artifacts;
- the test suite under `test/`;
- the published setup guide under `guide/`;
- two generated artifacts — `manual/analytics.utcp.json`, built from
  [github.com/zoho/analytics-oas](https://github.com/zoho/analytics-oas), and
  `knowledge/knowledge.json`, built from
  [github.com/zoho/analytics-okf](https://github.com/zoho/analytics-okf).

## Until the terms are approved

No licence is granted by the publication of this repository. Until the owners below
approve a licence, this code is for **evaluation and internal use only**: clone it,
run it, read it, file issues. Do not redistribute it, publish it to a package
registry, or ship it inside another product.

## Recommended terms, subject to approval

- **Source code** (`src/`, `tools/`, `test/`, `guide/build.py`):
  [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) — the usual
  choice for Zoho's published client libraries, and the one that lets this be
  installed as a dependency without attribution friction.
- **The guide** (every `.md` and the rendered `.html` under `guide/`):
  [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/),
  so the setup and security chapters can be quoted and adapted with attribution.
- **`knowledge/knowledge.json`**: cleared for redistribution. It is generated
  from [github.com/zoho/analytics-okf](https://github.com/zoho/analytics-okf),
  a public release owned by this repository's author, who permits it being
  bundled with and distributed as part of this tool. The bundle records the OKF
  version it came from, so its provenance stays checkable.
- **`manual/analytics.utcp.json`**: inherits the terms of
  [github.com/zoho/analytics-oas](https://github.com/zoho/analytics-oas).
  Confirm those permit redistribution in a package before publishing one.
- **Trademarks**: Zoho, Zoho Analytics and related marks are not licensed by any of
  the above and remain the property of Zoho Corporation.

## Before this is published to a registry

1. The owners of this code approve the terms above, or replace them.
2. This file is replaced with the approved licence text, and `package.json`'s
   `license` field is set to the matching SPDX identifier instead of
   `SEE LICENSE IN LICENSE.md`.
3. The upstream terms of `analytics-oas` are confirmed to permit redistributing
   the generated `manual/analytics.utcp.json`. (`knowledge/` is already cleared
   — see above.)

Copyright (c) Zoho Corporation Pvt. Ltd. All rights reserved.
