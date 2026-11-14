# Adapters that ship with the toolkit

Each folder is one adapter, written to the protocol in [docs/ADAPTERS.md](../docs/ADAPTERS.md). Each has its own README, sample cases, and tests in `test/`, which `npm test` runs.

[registry.yaml](registry.yaml) lists each one with its level. Shipping here does not make an adapter `core`: it stays `experimental` until a real project has used it. See [the levels](../docs/ADAPTER-CONTRIBUTING.md#levels).
