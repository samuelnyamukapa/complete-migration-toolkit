# Writing and sharing an adapter

This guide takes you from nothing to an adapter someone else can install. You need Node 22.5 or later, git, and a cmtk you can run. You do not need anyone's permission, and you do not need a toolkit release.

A test follows this guide: it writes an adapter with these commands, publishes it in a registry, and installs it in another project.

## 1. Write it

```
cmtk adapter new mailbox
```

This writes `adapters/mailbox/` with a working template. For C#, add `--lang csharp`. Write `run()`, and `reset()` if each case that writes needs a clean start. The protocol, and the rules every adapter keeps, are in [ADAPTERS.md](ADAPTERS.md).

Add sample cases to `samples/cases.yaml`. If the adapter needs a service to talk to, start a local stand-in in your tests. Never use a real payment or messaging service.

## 2. Pass the kit

```
cmtk adapter check mailbox
```

The kit runs every sample twice. It checks that the adapter answers `describe`, that each case gives an observation, that the same case gives the same observation, and that no header value appears in what it reports. An adapter that fails the kit has no level.

## 3. Add a licence

Put a `LICENSE` file in the adapter's folder. Without one, `cmtk adapter add` warns the person installing it, who may well say no.

## 4. Publish it in a registry

A registry is a git repository or a plain folder with a `registry.yaml` at the top. It can hold the adapters themselves, or point at other repositories.

```yaml
adapters:
  - name: mailbox
    kinds: [email]
    language: node
    level: experimental
    source: mailbox
    licence: MIT
    owner: Acme Testing Team
    version: 1.2.0
```

| Field | Needed | Meaning |
|---|---|---|
| `name` | yes | The folder it installs to, and the surface name. Letters, digits, `.`, `-` and `_`. Not `http` |
| `kinds` | yes | What it covers. Boundary kinds such as `email` are offered as `covers:` after install |
| `language` | yes | Such as `node` or `csharp` |
| `level` | yes | `experimental` or `verified`. See [Levels](#levels) |
| `source` | yes | A folder inside the registry, or another repository: see below |
| `licence` | yes | Such as `MIT`. Spelled this way |
| `owner` | yes | Who answers for it |
| `version` | no | For people to read. The commit is the real pin |

An adapter in another repository names the exact commit. A tag or a branch is refused, because it can move after a person said yes:

```yaml
    source: { git: https://github.com/acme/mailbox-adapter.git, commit: 6f1c0a7e5b2d4c3a9e8f7d6c5b4a39281706f5e4, path: . }
```

Only plain files install. A symbolic link or a submodule refuses the install. `bin`, `obj` and `node_modules` are left out, so a person builds what they have read. cmtk does not run `npm install`, so avoid dependencies, and pin exact versions of any you must have.

## 5. Install it

A person installs, at a terminal:

```
cmtk adapter add mailbox --registry https://github.com/acme/cmtk-adapters.git
cmtk adapter check mailbox
cmtk adapter list
```

`add` shows the source, licence, owner, level, commit and files, and warns about install scripts and ready-to-run files. It then asks for a name, and installs only if the person types `yes`. Nothing runs during an install.

The install is pinned. Use `--pin <tag, branch or commit>` to choose a version from a git registry; cmtk records the commit it resolves to, and the fingerprint of the files, in `adapters/installed.yaml`. Later changes in the registry change nothing here. `cmtk adapter list` says `CHANGED since install` if the files no longer match. To move to another version, remove the folder and its entry, and add it again.

`add` then prints how to register the adapter in `cmtk.yaml`. It does not edit that file.

## Scripts and agents cannot install

`cmtk adapter add` refuses to start without a terminal. It has no `--yes` flag and no setting to skip the question, and no MCP tool installs an adapter. An agent can tell a person the command, and that is all.

This stops accidents and agents that follow the rules. It does not stop a determined script, and it cannot prove a person is there: something driving a fake terminal could type `yes`, as it could for `cmtk signoff`. So the name goes on the install, in `adapters/installed.yaml`. Keep that file under version control, and require a reviewed commit to change it.

## Private registries

For adapters a client keeps to itself, list the registry in `cmtk.yaml`:

```yaml
adapter_registries:
  acme: git@git.acme.example:testing/cmtk-adapters.git
  shared: ../shared-adapters
```

Then `cmtk adapter add mailbox` looks in each one, or `--registry acme` picks one.

- **No default registry.** cmtk fetches only from what you name, so a private adapter's name never reaches anyone else, and no public adapter can stand in for it.
- **The same name in two registries is refused** until you choose one with `--registry`.
- **Credentials stay in git.** Access uses your own ssh key or git credential helper. An address that holds a password or a token is refused, and is not printed or stored.
- **Encrypted or local only.** `https`, `ssh`, `file` and folders are allowed. `http` and `git` are refused, because anyone on the network could swap the code. So are git's remote helpers, such as `ext::`, which can run commands.
- **A plain folder has no history,** so `--pin` is refused there and the fingerprint of the files is the pin.

## Levels

| Level | Means | Who says so |
|---|---|---|
| `experimental` | Passes the conformance kit | The registry's owner |
| `verified` | Passes the kit, and was used on one real project | The registry's owner. For the toolkit's own, a maintainer |
| `core` | Ships with the toolkit, with real use behind it | A maintainer. A registry that claims it is refused |

A level in a registry is that registry's claim. cmtk does not check it at install, so `cmtk adapter check` is your proof that the kit passes here.

An adapter can ship in [adapters/](../adapters/registry.yaml) and still be `experimental`: shipping alone proves no real use. That file says which level each one has. Today `http`, which is built in, is `core`.
