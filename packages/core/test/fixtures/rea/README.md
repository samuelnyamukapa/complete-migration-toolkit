# Recorded REA output

Real output of `rea-agents` 6.8.0, cut down to the fields cmtk reads. Nothing here is written by hand except the C# in `src/`.

| File | Made from |
|---|---|
| `Shop.members.json`, `Shop.artifact.json` | `mcs -deterministic -target:library -out:Shop.dll src/Shop.cs src/framework-stubs.cs` |
| `ShopCore.members.json` | `src/ShopCore.cs`: the same public surface, in another namespace |
| `ShopCoreChanged.members.json` | `src/ShopCoreChanged.cs`: planted changes |

`mcs` is Mono's compiler (6.8). `framework-stubs.cs` stands in for `System.Web`, so the compiler needs no reference to it. To record again: compile, then run `rea inspect-managed-members <dll> --json` and `rea inspect-managed-artifact <dll> --json`.

These are small assemblies made for the tests. eShop's real assemblies have not been read by this code.
