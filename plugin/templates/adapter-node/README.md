# __NAME__ adapter

An adapter for the Complete Migration Toolkit. It drives one kind of boundary and reports what it saw.

1. Write `run()` in `index.mjs`, and `reset()` if each case must start from a clean state.
2. Add sample cases to `samples/cases.yaml`.
3. Run `cmtk adapter check __NAME__` until it passes.
4. Register it in `cmtk.yaml`:

   ```yaml
   adapters:
     __NAME__: { command: node, args: [adapters/__NAME__/index.mjs] }
   ```

5. Give cases `surface: __NAME__`.

Rules: write nothing but JSON lines to stdout, never print a header value or a secret, and refuse live credentials for anything that moves money or sends real messages.
