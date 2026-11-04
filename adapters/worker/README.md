# Worker adapter

Tests a background service by what it does. It gives a Windows service or a .NET worker the same input, waits until it has finished, and reports what it produced. Written in C# from the `cmtk adapter new --lang csharp` template. It needs the .NET 8 SDK.

**Test machines only.** Never start or stop a service on a shared or production machine.

## What a case does

| Method | What happens |
|---|---|
| `POST` or `PUT` | Drops `body` or `body_file` as a file at `path` inside the input folder, waits until the worker has finished, then reports |
| `GET`, `HEAD` or `OPTIONS` | Only reports. It starts nothing and drops nothing |

Any other method, and `before`, `body_form` or `files`, gives an error naming it. Input is a file only: a message or a database row as input is not built yet.

```json
{ "status": 200, "effects": {
    "outputs": [{ "path": "order.txt.out.txt", "bytes": 8, "text": "ONE\nTWO\n" }],
    "events": [{ "source": "OrderSvc", "level": "4", "id": "100", "message": "Finished order.txt at <time> in pid <id>" }] } }
```

- **outputs:** every file in the output folder, sorted by path. A binary file, or one over 256 KB, gives `sha256` in place of `text`. No file times.
- **events:** only with `event_source`, and only on Windows. The entries that source wrote during this case. No time, process id, thread id, record number, machine or user. Times and process ids in the message become `<time>`, `<date>` and `<id>`. Anything else that changes on every run needs a `scrub` rule in `cmtk.yaml`.

`reset` stops the worker, empties the input and output folders, copies the baseline back, and starts the worker again. `cmtk compare` calls it only before a case that writes, so a GET compares the outputs each system holds now.

## Settings

Set these for each target in `cmtk.yaml`.

| Setting | Meaning |
|---|---|
| `test_area` | A folder that already exists and holds nothing but this test's files. Required |
| `input_folder`, `output_folder` | Required. A relative path starts at `test_area` |
| `baseline_folder` | Optional. Its `input/` and `output/` folders are the starting state |
| `service` | The name of a Windows service, controlled with `sc.exe` |
| `start` | Or the command that runs a worker, such as `dotnet run --project src/Worker -c Release --no-build`. No shell is used. The worker gets `CMTK_WORKER_INPUT_FOLDER` and `CMTK_WORKER_OUTPUT_FOLDER` |
| `finish` | How to tell it has finished. `input-gone`: the input file has gone. `file:done.flag`: this file has appeared in the output folder. It is deleted before each drop and left out of the report. `quiet`: the output folder has not changed |
| `finish_quiet_ms` | The output folder must also stay unchanged this long. Default 300. With `quiet`, set it longer than the worker can take to begin |
| `finish_timeout_s` | Give up and report an error after this long. Default 30 |
| `event_source`, `event_log` | The event log source to report, and its log. Default log: `Application` |

Give exactly one of `service` or `start`.

```yaml
targets:
  legacy:
    test_area: C:/cmtk-test/legacy
    input_folder: in
    output_folder: out
    baseline_folder: baseline
    service: OrderService
    finish: input-gone
    event_source: OrderService
  candidate:
    test_area: C:/cmtk-test/candidate
    input_folder: in
    output_folder: out
    baseline_folder: baseline
    start: dotnet run --project src/OrderWorker -c Release --no-build
    finish: input-gone
    event_source: OrderWorker
adapters:
  worker: { command: dotnet, args: [adapters/worker/bin/Release/net8.0/worker.dll], covers: [worker, files, logs] }
allow_unsafe_methods: true   # a drop changes data, so it also needs --allow-unsafe on the run
```

Give cases `surface: worker`. A service reads its folders from its own configuration, so point that at the same `in` and `out`.

## Safety

- **Folders stay in the test area.** The input, output and baseline folders must be inside `test_area`, and separate from each other. Anything else is refused before any file is touched. So is a path through a link, a case path outside the input folder, and a `test_area` that is a drive root, the home folder or a parent of it.
- **Services need a person's say-so.** Service control is refused unless `CMTK_WORKER_TEST_MACHINE` holds this machine's name. Set it on the test machine only.
- **A worker cannot touch the protocol.** Its standard input is closed, and what it prints goes to standard error.
- **Headers are not used,** so none can be reported.

When the run ends, a worker the adapter started is stopped, and a service stays as it is. If the toolkit has to kill the adapter for giving no answer, a worker on Windows can be left running: stop it yourself.

## Run the conformance kit

```
dotnet build -c Release adapters/worker
dotnet build -c Release adapters/worker/sample-worker
cmtk adapter check worker
```

Run these from the toolkit's own folder. The kit runs `samples/cases.yaml` against the tiny sample worker in `sample-worker/`, in `test-area/`, using the settings under `check_target:` there. `npm test` does this too, and also runs a `cmtk compare` with a planted difference.

## What has and has not been tested

Run on Linux with the real .NET compiler and the sample worker: everything to do with files, `start`, `reset`, the safety rules and `cmtk compare`. On Linux, `sc.exe` and `wevtutil.exe` are small stand-ins written by the tests, which check the calls made and how the answers are read.

Not yet run: the real `sc.exe` against a real service, and anything on Windows. A test against the real event log is written and runs only on Windows. The sample worker is a console program, so a test of a real service needs a Windows machine and a small service to install there. This adapter stays **experimental** until the pilot uses it.
