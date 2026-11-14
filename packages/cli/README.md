# complete-migration-toolkit

The `cmtk` command. Test any system from its requirements, and prove a migrated system behaves like the old one, with every intended drift approved and signed.

You need Node.js 22.5 or later.

```sh
npx cmtk init --legacy http://localhost:5001 --candidate http://localhost:5002
npx cmtk run          # the candidate against cmtk/cases/*.yaml
npx cmtk compare      # the same cases on both systems, diffed
npx cmtk signoff run  # a person signs, at a keyboard
```

The guide, the runbook and the formats are in the [repository](https://github.com/samuelnyamukapa/complete-migration-toolkit).
