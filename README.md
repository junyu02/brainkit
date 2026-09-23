# brainkit

brainkit is a personal second-brain system that happens to be open source. It keeps long-term
memory as plain Markdown in an Obsidian vault, and gives humans and AI assistants one shared,
audited way to write into it: a zero-dependency Node.js CLI, plus a few macOS background
daemons that capture material and promote it into the vault.

Read the positioning literally. This is one person's production system, extracted and cleaned up
to a publishable standard — not a product. The maintainer is the only production user, there is no
support commitment, no stability guarantee, and no attempt to be generically configurable. Some
defaults still encode the maintainer's own setup. It is published because the design may be useful
to read, fork, or steal ideas from. See [docs/DESIGN.md](docs/DESIGN.md) for the full positioning
and the trade-offs behind it.

Most documentation under `docs/` is written in Chinese, matching the vault it manages.

## Architecture

```
  AI coding sessions            clipboard / screenshots
  (Claude, Codex transcripts)   (macOS daemon)
            |                             |
            v                             v
  ┌──────────────────────┐      ┌──────────────────────┐
  │ observe.mjs          │      │ brain-clip           │
  │ extract observations │      │ vision/text via LLM, │
  │ from local sessions  │      │ queued for review    │
  └──────────┬───────────┘      └───────────┬──────────┘
             |                              |
             v                              |
  ┌──────────────────────┐                  |
  │ 08-观察 observations │                  |
  │ (unconfirmed process |                  |
  │  material)           │                  |
  └──────────┬───────────┘                  |
             |                              |
      ┌──────┴────────┐                     |
      v               v                     |
 ┌──────────────┐ ┌──────────────┐          |
 │ brain-harvest│ │ brain-weekly │          |
 │ LLM clusters │ │ LLM weekly   │          |
 │ → candidates │ │ digest       │          |
 │ → human      │ │ → 09-周报    │          |
 │   review UI  │ │              │          |
 └──────┬───────┘ └──────┬───────┘          |
        |                |                  |
        └────────┬───────┴──────────────────┘
                 v
      ┌────────────────────────────┐
      │ brain-write.mjs            │   the only intended write entry:
      │ section policy → dedup →   │   routing, duplicate check,
      │ index update → ledger      │   host index refresh, append-only ledger
      └────────────┬───────────────┘
                   v
      ┌────────────────────────────────────────────────┐
      │ vault (Obsidian, Markdown is the source truth) │
      │ 00-系统 control plane · 01-项目 · 02-知识       │
      │ 03-经验 · 04-对话 · 05-persona · 06-归档        │
      │ 08-观察 · 09-周报                               │
      └────────────────────▲───────────────────────────┘
                           │  whitelist + manifest, never a silent overwrite
      ┌────────────────────┴───────────────────────────┐
      │ scripts/publish.mjs  (this repo → vault code)  │
      └────────────────────────────────────────────────┘
```

Two rules hold the whole thing together.

**Markdown is the fact layer.** Frontmatter and prose in the vault are the truth. Every JSON
index, cache and host-side hot index is a rebuildable projection and may never write back over the
Markdown. Recovery from a corrupted index is "delete it and rebuild", never "reconcile".

**The repo is canonical for code; the vault is canonical for memory.** This repository holds the
scripts, plist templates and docs. The vault holds the memory content, which never enters this
repository. `scripts/publish.mjs` deploys only the files listed in `publish-whitelist.json` into the
vault's `00-系统/scripts/`, tracks them in a manifest, and classifies any divergence as repo-ahead,
vault-ahead or conflict. A vault-side hotfix is reported, not silently overwritten.

## Prerequisites

- Node.js 22+ and Git. There is no `npm install` — the runtime has zero npm dependencies.
- The CLI runs on any platform with a filesystem and Node.js. The daemons are **macOS-only**: they
  depend on launchd, `plutil`, `fswatch`, and `swiftc` for the clipboard helper.
- An Obsidian vault, either existing or created following [docs/MIGRATION.md](docs/MIGRATION.md).
- Optional, only for the LLM-backed steps (clip understanding, harvest clustering, weekly digest):
  a DeepSeek API key. It lives in a private env file owned by the current user with mode 0600, and
  never in a plist, template, log, or in git.

## Quick start

The supported macOS setup entry point is `node install.mjs install`; read
[docs/INSTALLER.md](docs/INSTALLER.md) before using it. Its `recover` command is diagnostic-only
and `uninstall` only prints a plan, so neither command performs the recovery or removal for you.
For a manual vault migration, use [docs/MIGRATION.md](docs/MIGRATION.md).

What you can run immediately after cloning, against a scratch vault:

```bash
export BRAIN_VAULT_ROOT=/absolute/path/to/vault

node tests/run-all.mjs            # full test suite, no vault writes
node scripts/publish.mjs --check  # report repo/vault drift, changes nothing
```

Day-to-day commands, once a vault is wired up:

| Command | What it does |
|---|---|
| `node scripts/cli/brain-write.mjs …` | Write one memory: route, dedup, index, ledger |
| `node scripts/cli/brain-write.mjs --dry-run …` | Preview a write without touching the vault |
| `node scripts/cli/brain-query.mjs --query "…"` | Search memories |
| `node scripts/cli/brain-status.mjs` | Portable status report for the whole pipeline |
| `node scripts/cli/vault-lint.mjs` | Audit-only hygiene check; never moves or deletes |
| `node scripts/cli/brain-harvest.mjs cluster` | Cluster observations into promotion candidates |
| `node scripts/cli/brain-harvest.mjs review` | Local review UI to approve or reject candidates |
| `node scripts/cli/brain-weekly.mjs --dry-run` | Preview the weekly digest |
| `node scripts/cli/brain.mjs capabilities` | Inspect the local memory interface |

Harvest produces candidates for its configured review flow. Structured records and connector
events are excluded from legacy text promotion; their evidence and stable identities remain intact.

## Local memory interface

`scripts/cli/brain.mjs` is a local JSON CLI and MCP stdio surface over the same vault. It exposes
15 operations: nine read/analysis operations (`capabilities`, `recall`, `entity`, `context_pack`,
`delta`, `open_loops`, `synthesize`, `doctor`, `sync_status`) and six governed writes (`remember`, `revise`,
`forget`, `restore`, `loops_close`, `ingest_events`). MCP starts read-only; writes require `serve --allow-writes` and
a recognized local actor, then still invoke `brain-write.mjs`. It is inspired by GBrain's seven
memory verbs (`recall`, `remember`, `entity`, `synthesize`, `forget`, `context_pack`, `delta`),
but is **not** protocol-compatible and does not claim GBrain conformance.

See [docs/MEMORY-INTERFACE.md](docs/MEMORY-INTERFACE.md) for operation schemas, scratch commands,
and the trust boundaries. Entities, facts, relationships and commitments have stable IDs and versions
inside Markdown. Model extraction produces unconfirmed candidates; answer synthesis includes a
separate support check. Connector intake records minimal events with repeat-safe updates and explicit
window checkpoints; an authorized host automation supplies Gmail/Calendar data using its existing
connectors. Brainkit does not create OAuth credentials or a scheduler account.

[Authenticated HTTP access](docs/REMOTE-MEMORY.md) can run on the same computer. A second machine
is optional, needed only if you want service availability while this computer is offline.

## Trust boundary

Stated plainly, because the difference between "enforced" and "agreed" matters here.

- `brain-write.mjs` is the only *intended* memory write entry, and it is enforced by convention
  and an append-only ledger — **not** by a sandbox. Directory-level permissions cannot stop a raw
  write inside a directory the writer is already allowed to touch. Integrity depends on the calling
  convention, the ledger, and external auditing.
- **The external guard/hook layer is not in this repository.** The production control plane that
  constrains how these scripts may be invoked lives elsewhere. Do not read this repo's conventions
  as a sandbox; it does not ship one.
- `publish.mjs` is the deliberate high-privilege exception: it bypasses the memory pipeline to
  deploy code. It compensates with a fixed entry point, a fixed whitelist, a clean-worktree
  requirement, realpath validation, a verifiable manifest, and an independent security review
  before the first real publish.
- **Same-UID malicious processes are out of scope**, entirely. The authorization ledger, recovery
  manifest checks, FD capability checks and test-injection path checks exist to catch
  misconfiguration, incidental corruption and non-malicious tool misuse. None of them authenticate
  a caller.
- Durability covers process-crash recovery only. Not every data path is fsynced, so there is no
  power-loss consistency promise.
- Credentials live only in owner-owned 0600 env files, read line by line against a key allowlist.
  No `source`, no `eval`, and plists never carry values.

## Known limitations

- The append-only `brain-write-ledger.jsonl` caps at 32 MiB (`MAX_LEDGER_BYTES`). Past the cap,
  `delta`, `sync_status`, `ingest_events`, record-id `recall`, and every `request_id` write (all
  HTTP writes) fail closed; plain-text `recall`/`entity`/`context_pack`/`open_loops` still work.
  Recovery is manual: rename the old segment into an archive file and continue from an empty
  ledger, only when no remote write is in flight.
- `ingest_events` redacts connector titles/summaries with the same credential patterns as the
  writer (`password:`, `sk-`, `AIza`, `ghp_`, `xoxb-`, `Bearer …`) before hashing, so a redacted
  event still replays with a stable hash.
- `doctor`'s `healthy` flag only means every check is `ok` or `not_configured`; a reachable
  semantic index reports `ok` with `freshness` always `unknown` — it is never claimed fresh.
- All-day `due` overdue checks compare UTC calendar dates, so under UTC+8 an item can read overdue
  up to 8 hours late.
- The HTTP auth file's directory check only walks its immediate parent, not the full path to root
  like the checkpoint state directory does — keep it under a path that is entirely user-owned and
  not group/world-writable.
- Retrieval quality still fails on some cross-language queries; the synthetic train/validation
  split and the 12-question public-document set (later used for tuning, so not a blind test) do not
  certify private full-vault quality.
- The optional MemPalace semantic index is a candidate source only — results are discarded unless
  they resolve back to current Markdown, and it never becomes a second source of truth.
- A structured note moved or retired by `brain-archive-aged.mjs --apply` (or any other unmanaged
  move) simply drops out of ledger-based discovery; it is not reported as an error. Its record_id
  or event_id also loses uniqueness protection — writing the same ID again is not refused, so two
  live notes can carry it. `doctor` reports `duplicate_id` for records; duplicate connector events
  need a manual check.

## Documentation

| Doc | Contents |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | Positioning, architecture, key technical decisions, boundaries |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Step-by-step setup and cutover runbook |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Host-neutral read/write protocol for AI assistants |
| [docs/MEMORY-INTERFACE.md](docs/MEMORY-INTERFACE.md) | Local CLI/MCP memory interface and its limits |
| [docs/VAULT-STRUCTURE.md](docs/VAULT-STRUCTURE.md) | Vault layout, naming, archival policy |
| [docs/brain-usage-guide.md](docs/brain-usage-guide.md) | CLI usage and diagnostics |
| [docs/sync-policy.md](docs/sync-policy.md) | Which vault layers are safe to sync |
| [docs/AGENTS.md](docs/AGENTS.md) | Rules for AI agents operating on the vault |

中文说明：`docs/` 下的文档均为中文，设计定位见 [docs/DESIGN.md](docs/DESIGN.md)，vault 读写规则见
[docs/PROTOCOL.md](docs/PROTOCOL.md)，首次搭建与迁移见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## License

MIT — see [LICENSE](LICENSE).
