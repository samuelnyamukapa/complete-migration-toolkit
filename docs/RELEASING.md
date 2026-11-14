# Releasing

Nothing has been published yet. The workflow is written and its checks are tested, but it has never run against npm. The first release needs the steps under [Before the first release](#before-the-first-release), and only the owner of the npm account can do them.

## What is published

| Package | What it is | How people run it |
|---|---|---|
| `@cmtk/core` | The engine | They do not: the others need it |
| `complete-migration-toolkit` | The `cmtk` command | `npx -p complete-migration-toolkit cmtk` |
| `@cmtk/mcp` | The MCP server | `npx @cmtk/mcp`, from an MCP client |
| `cmtk` | Holds only a pointer to `complete-migration-toolkit` | `npx cmtk` |

`npx cmtk` looks for a package called `cmtk`, so that package has to exist. Without it, `npx cmtk` would fail, or would run whatever someone else published under that name. It lives in `packages/npx-cmtk`, and it is not a workspace, because npm would not install it until its dependency is on the registry.

The plugin is not on npm. It keeps its own bundled copy in `plugin/server`.

## Version numbers

Versions are major.minor.patch, and all four packages share one version.

- **Major:** anything frozen in [FORMATS.md](FORMATS.md) changes in a way that can break someone.
- **Minor:** a new command, setting or field that nothing relies on being absent.
- **Patch:** a fix.

Each release has an entry in `CHANGELOG.md`, headed `## 1.2.3 (date)`. `scripts/check-release.mjs` refuses a tag when a version, a dependency between the packages, or the entry does not match.

## Before the first release

These need the npm account's owner. An agent does not do them.

1. Turn on two-factor sign-in for the npm account.
2. Check the names are still free, and create the npm organisation `cmtk`, so that `@cmtk/core` and `@cmtk/mcp` can be published. On 4 November 2026 the registry had no `cmtk`, `complete-migration-toolkit` or `@cmtk/core`. A name stays free only until someone takes it.
3. Create a granular access token that can publish those four packages, and nothing else.
4. In the GitHub repository, create an environment called `npm`, and add the token to it as a secret called `NPM_TOKEN`. The token goes nowhere else: not in a file, a chat or a log. Require your approval on the environment, so that a tag alone cannot publish.

## Each release

1. Set the same version in all four `package.json` files. Set `@cmtk/core` in the CLI and the MCP package to `^` that version, and `complete-migration-toolkit` in `packages/npx-cmtk` to exactly that version.
2. Add the `CHANGELOG.md` entry, then run `npm install` for the lock file and `npm run bundle` for the plugin.
3. Check it, with no token and without publishing anything:

   ```sh
   npm test
   node scripts/check-package.mjs
   node scripts/check-release.mjs v1.2.3
   ```

4. Merge, then tag and push the tag: `git tag v1.2.3`, then `git push origin v1.2.3`.

The workflow tests on Windows and Linux, waits for your approval, publishes in dependency order with provenance, then runs `npx cmtk --version` from the registry on clean Windows and Linux machines. If it stops half way, run it again: a version already on npm is left alone.

## What the contents check refuses

`scripts/check-package.mjs` asks npm for the exact files of each package, and refuses:

- anything but `dist`, `templates`, `package.json`, the README and the licence files;
- test fixtures, evidence folders and reports, recordings, keys, logs and environment files;
- text that holds a live payment key, a cloud key, a GitHub or npm token, a private key, a signed token, or a path from a developer's machine.

It names the file and the kind of problem, and never quotes what it found.

## After the first release

Follow [Part 1 of the runbook](RUNBOOK.md#part-1-test-one-system-against-its-requirements) on clean Windows and Linux machines, using `npx cmtk`. That is how [#32](https://github.com/samuelnyamukapa/complete-migration-toolkit/issues/32) is proved, and a test here cannot stand in for it.
