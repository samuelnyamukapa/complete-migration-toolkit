# __NAME__ adapter

An adapter for the Complete Migration Toolkit, written in C#. It drives one kind of boundary and reports what it saw. It needs the .NET 8 SDK.

1. Build it, and run the conformance kit. The example passes as it is:

   ```
   dotnet build -c Release adapters/__NAME__
   cmtk adapter check __NAME__
   ```

2. Write `Run()` in `Adapter.cs`, and `Reset()` if each case must start from a clean state. If it starts anything, stop it in `Close()`. `Program.cs` speaks the protocol, so you should not need to change it.
3. Add sample cases to `samples/cases.yaml`. If the adapter needs settings from its target, add them there under `check_target:`.
4. Build and run `cmtk adapter check __NAME__` until it passes. It refuses to test a build older than your code.
5. Register the built program in `cmtk.yaml`:

   ```yaml
   adapters:
     __NAME__: { command: dotnet, args: [adapters/__NAME__/bin/Release/net8.0/__NAME__.dll] }
   ```

   Or use `dotnet run`. Keep `--no-build`, because a build writes to standard output and that breaks the protocol. Set `DOTNET_NOLOGO=1` too, because the first run of `dotnet` on a machine can print a welcome message there.

   ```yaml
   adapters:
     __NAME__: { command: dotnet, args: [run, --project, adapters/__NAME__, -c, Release, --no-build] }
   ```

6. Give cases `surface: __NAME__`.

Rules: `Console.WriteLine` is safe, because here it goes to standard error. Never print a header value or a secret: `Program.cs` hides the exact values it was given, but it cannot spot one you have changed, such as encoded in Base64. Refuse live credentials for anything that moves money or sends real messages.
