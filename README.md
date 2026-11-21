# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/musefixi/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/musefixi/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single TypeScript process, Node standard library only — no git binary, no database, no outside services. One in-memory store backs every surface, so an issue opened over MCP is the issue the REST API reads back. It serves git smart HTTP (upload-pack protocol v2 with shallow fetch, receive-pack v0 with report-status) with git objects and packfiles implemented in-process, the REST v3 API (repositories, branches, git refs, commits, contents, labels, issues, comments, pull requests with three-way merge), the GraphQL v4 API (queries, connections, mutations, introspection) and an MCP endpoint (server/discover plus repository/issue/pull-request tools). Bearer-token auth guards the API surfaces; timestamps come from a logical clock so trial replays are deterministic.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, serves until the env reports done, and exits 0. `MAKEFUN_SHOP_TOKEN` is the bearer token the API surfaces require.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4yp70nzv&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
