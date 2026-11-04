// The shapes every part of the toolkit shares. Plain data, so a person can read and edit
// every file the toolkit writes, and an adapter in any language can produce them.

/** How strict a comparison is. Set for the whole system, then loosened per path or per case. */
export type MatchLevel = "exact" | "semantic" | "contract" | "journey";
/** The kinds of boundary `cmtk discover` lists, and an adapter's `covers` names. */
export const BOUNDARY_KINDS = ["http", "soap", "outbound-http", "database", "files", "email", "sms", "queue", "payments", "worker", "ui", "logs"] as const;
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

export const MATCH_LEVELS: readonly MatchLevel[] = ["exact", "semantic", "contract", "journey"];

/**
 * One system the toolkit can send cases to. `base_url` is needed for HTTP cases; any other
 * setting (a queue name, a folder, a program to run) is passed as it is to the adapters.
 */
export interface Target {
    name: string;
    base_url?: string;
    /** The surfaces this target offers, such as ["catalog"]. Not listed: it takes part in every case. */
    surfaces?: string[];
    [setting: string]: string | number | boolean | string[] | undefined;
}

export interface Override {
    /** A glob on the request path, such as "/api/admin/*". */
    path: string;
    match: MatchLevel;
}

export interface Contract {
    name: string;
    /** openapi (JSON), wsdl, xsd, or text. */
    kind: string;
    /** Served by each target at this path. */
    path: string;
}

export interface Scrub {
    /** JSON paths whose values are replaced before comparing, such as "$..createdAt". */
    json_paths: string[];
    /** XML element local names whose content is ignored. */
    xml_ignore: string[];
    /** Regular expressions replaced in text, in both systems' answers. */
    regex: { pattern: string; replace?: string }[];
}

/** Dated copies of each run's evidence, and the rule for removing old ones. */
export interface EvidenceHistory {
    /** Keep every run in a dated folder, as --dated does for one run. */
    dated: boolean;
    /** Remove dated runs older than this many days. */
    keep_days?: number;
    /** Keep at most this many dated runs per mode. */
    keep_runs?: number;
    /** The most the dated runs may take up, in megabytes. */
    max_mb: number;
}

/** cmtk.yaml: everything about one system under test. */
export interface Manifest {
    system: string;
    targets: Record<string, Target>;
    /** The target `cmtk run` uses when none is named. */
    default_target: string;
    /** For `cmtk compare`: the reference (usually the legacy system) and the candidate. */
    reference: string;
    candidate: string;
    match: MatchLevel;
    overrides: Override[];
    scrub: Scrub;
    compare_headers: string[];
    contracts: Contract[];
    /** Globs, relative to the manifest, of the case files. */
    cases: string[];
    drift: string;
    /** The known-issues ledger: failures of `cmtk run` that a named person accepted. */
    known_issues: string;
    /** Proposals from agents (scrubs, drift, known issues, defects, expectation changes) waiting for a person. */
    proposals: string;
    /** The most requests exploration may send in one day, across all sessions. */
    explore_requests_per_day: number;
    evidence: string;
    evidence_history: EvidenceHistory;
    allow_unsafe_methods: boolean;
    /** Header name to environment variable name. Values are read at run time and never written. */
    headers_from_env: Record<string, string>;
    timeout_s: number;
    insecure_tls: boolean;
    /** Surfaces whose cases exist only to compare two systems: `cmtk run` leaves them out and says so. */
    compare_only_surfaces: string[];
    /** Adapters beyond the built-in http one: surface name to the program that runs it. */
    adapters: Record<string, { command: string; args?: string[]; timeout_s?: number; covers?: string[] }>;
    /** Registries `cmtk adapter add` looks in: name to a git address or a folder. Often private. */
    adapter_registries: Record<string, string>;
    /** Folder the manifest lives in; every relative path is resolved against it. */
    root: string;
    /** The manifest file itself. */
    file: string;
}

export interface Request {
    method: string;
    /** A path only, never a host: requests go to a target's base URL. */
    path: string;
    headers?: Record<string, string>;
    body?: string | null;
    /** A file inside the project whose bytes are the body. Set by the loader from `body_file`. */
    body_file?: string;
    /** Files sent as multipart/form-data. Set by the loader from `files`. */
    files?: UploadPart[];
    /**
     * Form fields, sent as application/x-www-form-urlencoded (or as the text parts of a multipart body when
     * `files` is also given). A string names a JSON file inside the project whose top-level fields are the form;
     * a mapping gives the fields inline. Set by the loader from `body_form`.
     */
    body_form?: string | Record<string, FormValue>;
    /** A page read before the request, for a value it carries (an anti-forgery token) and the cookies it sets. */
    before?: Before;
}

/** What a form field may hold: a scalar, or a list of scalars sent as repeated fields. */
export type FormValue = string | number | boolean | null | (string | number | boolean | null)[];

/**
 * One GET to the same target before the request. Every cookie it sets goes on the request, and each `take`
 * entry puts one value from the page into a form field: a selector `input[name=x]` (its `value`), `meta[name=x]`
 * (its `content`), `tag[attr=x]@attr`, `regex:<pattern with one group>` or `cookie:<name>`.
 * The values taken are never written to evidence; their names are.
 */
export interface Before {
    get: string;
    take?: Record<string, string>;
}

/** What a `before` page gave, as the evidence records it: names, never values. */
export interface BeforeOutcome {
    request: string;
    status?: number;
    took: string[];
    cookies: string[];
}

/** One part of a multipart/form-data body: a file inside the project, under a form field. */
export interface UploadPart {
    field: string;
    path: string;
    filename?: string;
    content_type?: string;
}

/** An input file a case sent, as the evidence records it: never the bytes, always the fingerprint. */
export interface InputFile {
    path: string;
    sha256: string;
    bytes: number;
    /** For an upload: the form field and the name the server saw. */
    field?: string;
    filename?: string;
    content_type?: string;
    /** "form" when the file's fields were sent as a form rather than its bytes as the body. */
    as?: "form";
}

/** A check on one answer, for `cmtk run`. Every field is optional. */
export interface Expectation {
    status?: number | number[];
    headers?: Record<string, string | { matches: string }>;
    /** JSON path to a check. */
    json?: Record<string, JsonCheck>;
    body_contains?: string[];
    /** Text that must never appear, such as a stack trace. */
    body_excludes?: string[];
}

export type JsonCheck =
    | { equals: unknown }
    | { exists: boolean }
    | { matches: string }
    | { type: "string" | "number" | "boolean" | "object" | "array" | "null" };

export interface Case {
    id: string;
    name?: string;
    /** The requirement or acceptance criterion this case answers for, such as "STORY-12/AC-1". */
    requirement?: string | string[];
    /** Which adapter runs it. Default: http. */
    surface?: string;
    request: Request;
    expect?: Expectation;
    match?: MatchLevel;
    /** A person confirmed this request changes nothing, though its method is not GET, HEAD or OPTIONS. */
    safe?: boolean;
    /** Where the case came from: a HAR file, a requirement, a person. */
    source?: string;
    /** Set by the loader: the file the case was read from, relative to the manifest. */
    file?: string;
    /** Drafted by an agent and not yet accepted by a person: reported as SKIPPED until `cmtk review` accepts it. */
    draft?: boolean;
    /** Why the drafter wrote the case this way, and any question for the reviewer. Kept as `note` when the draft is accepted. */
    draft_note?: string;
    /** Where the case came from and what it depends on, in words. */
    note?: string;
    /** Who accepted the draft, and when. Written by `cmtk review`. */
    accepted_by?: string;
    accepted_on?: string;
    /** `expect` was drafted from a recording and no person has confirmed it: `cmtk run` skips the case until `cmtk review` does. */
    expect_draft?: boolean;
    /** Who confirmed a drafted expectation, and when. Written by `cmtk review`. */
    expect_confirmed_by?: string;
    expect_confirmed_on?: string;
}

/** What a UI journey did, as an adapter reports it. Plain facts: the engine decides what differs. */
export interface JourneyOutcome {
    /** The task, in words, such as "find a red jacket and add it to the basket". */
    goal: string;
    /** The checks in code that decide pass or fail. */
    checks: { name: string; passed: boolean; expected?: string; actual?: string }[];
    /** Key values the screens showed, by the name the journey gave them. Null when the screen did not show it. */
    values: Record<string, string | null>;
    /** Pages reached, in order. A `name` is a milestone the journey named, and it is what `journey` compares; the path may differ between systems. */
    pages: { name?: string; path: string; status?: number }[];
    /** The API calls each page made. Reported, and compared only through `api_compared`. */
    api_calls?: { page: string; method: string; path: string; status?: number }[];
    /** "POST /api/basket 200": the calls a journey asked to have compared. */
    api_compared?: string[];
    /** What the browser was not allowed to send, such as a write on a read-only case. */
    blocked?: { why: string; request: string }[];
}

/** A screenshot an adapter took. The engine writes it to the evidence folder. It is evidence, never the test. */
export interface Screenshot {
    /** The page or milestone it shows. */
    page: string;
    png_base64: string;
}

/** A screenshot as the evidence records it. */
export interface ScreenshotFile {
    page: string;
    file: string;
    sha256: string;
    bytes: number;
}

/** What one target answered to one case. Adapters return this shape. */
export interface Observation {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    /** The files the request sent, fingerprinted. */
    inputs?: InputFile[];
    /** The page read before the request, and what was taken from it, by name. */
    before?: BeforeOutcome;
    /** "utf-8" (the default) or "latin1" when the bytes were not valid UTF-8; latin1 keeps every byte. */
    body_encoding?: string;
    sha256?: string;
    truncated?: boolean;
    /** Side effects an adapter observed: emails, messages, rows, files. Compared like a JSON body. */
    effects?: Record<string, unknown>;
    /** A UI journey's outcome: what the `journey` level compares. */
    journey?: JourneyOutcome;
    /** Screenshots, sent as base64. The engine writes them as files and keeps only their names and fingerprints in the answer. */
    screenshots?: Screenshot[];
    /** How many calls to a model this answer took. An adapter that has no model reports 0. */
    model_calls?: number;
    error?: string;
}

export interface Difference {
    /** "status", "header:<name>", a JSON path, an XML path or "body line N". */
    where: string;
    reference: string;
    candidate: string;
    /** The drift ledger entry that expects this difference, if any. */
    drift?: string;
}

/** An approved difference between the reference and the candidate. Only a person adds one. */
export interface Drift {
    id: string;
    /** A case id, or "*" for every case. */
    case: string;
    /** A `where` value from a report; JSON paths may use [*] and ..; other values are globs. */
    where: string;
    reason: string;
    approved_by: string;
    date?: string;
}

/** One failure a known issue accepts, in the words of a report. Leave out `expected` or `actual` to accept any. */
export interface KnownFailure {
    check: string;
    expected?: string;
    actual?: string;
}

/** A failure that must stay for now, such as a legacy defect. Only a person adds one. */
export interface KnownIssue {
    id: string;
    /** One case id, never a wildcard. */
    case: string;
    fails: KnownFailure[];
    reason: string;
    accepted_by: string;
    date?: string;
    /** Only on this target. Default: every target. */
    target?: string;
}

/** A ledger entry as a report lists it: still failing, stale, or not checked by this run. */
export interface KnownIssueInReport extends KnownIssue {
    state: "still fails" | "no longer fails" | "not checked";
}

export type CaseResult =
    | "PASS" | "FAIL"            // cmtk run
    | "MATCH" | "DRIFT" | "DIFFERENT" // cmtk compare (DRIFT: only approved differences)
    | "NOT COMPARABLE"           // cmtk compare: a target has no surface for this case, so nothing was sent
    | "SKIPPED" | "ERROR";

export interface Failure {
    check: string;
    expected: string;
    actual: string;
    /** The known issue that accepts this failure, if any. */
    known_issue?: string;
}

export interface CaseOutcome {
    id: string;
    name: string;
    /** "GET /path": what was sent, so a reader of REPORT.json needs no case file. */
    request?: string;
    /** The input files the case sent, fingerprinted. */
    inputs?: InputFile[];
    /** The page read before the request, and what was taken from it, by name. */
    before?: BeforeOutcome;
    requirement: string[];
    surface: string;
    /** No adapter drives this case's surface, so nothing was sent. */
    no_adapter?: boolean;
    match?: MatchLevel;
    result: CaseResult;
    why?: string;
    failures?: Failure[];
    differences?: Difference[];
    note?: string;
    /** An answer was over 5 MB, so only its first 5 MB were checked. The verdict says so. */
    truncated?: true;
    /** Set when result is FAIL and every failure is accepted by these known issues. */
    known_issues?: string[];
}

export interface ContractFinding {
    /** true breaks consumers; false is compatible; null needs a person. */
    breaking: boolean | null;
    what: string;
    /** "contract:<name>: <what>", for the drift ledger. Every finding is a change, so each needs approval. */
    where?: string;
    /** The drift ledger entry that approves this change, if any. */
    drift?: string;
}

export interface ContractOutcome {
    name: string;
    kind: string;
    result: "IDENTICAL" | "EQUIVALENT" | "COMPATIBLE" | "BREAKING" | "REVIEW" | "ERROR" | "NOT COMPARABLE";
    findings: ContractFinding[];
}

export type Verdict =
    | "PASS" | "PASS WITH KNOWN ISSUES" | "FAIL" // cmtk run
    | "PARITY" | "DRIFT ONLY" | "NO PARITY"  // cmtk compare
    | "PARTIAL COMPARISON"                   // cmtk compare: no open difference, but only part of the system was compared
    | "INCOMPLETE" | "NO EVIDENCE";

export interface ReportSettings {
    /** The settings file, relative to the project folder, and a fingerprint of its text. */
    manifest: string;
    manifest_sha256: string;
    match: MatchLevel;
    overrides: Override[];
    scrub: Scrub;
    drift_file: string;
    drift_entries: number;
    known_issues_file?: string;
    known_issues_entries?: number;
}

/** What a comparison covered. Present when a target lists its surfaces. */
export interface ReportScope {
    /** True when every surface the targets list was compared by at least one case, and every case and contract was comparable. */
    whole: boolean;
    /** In words, for a person: what was compared and what was not. */
    statement: string;
    compared: { surface: string; cases: number }[];
    not_compared: { surface: string; cases: number; why: string }[];
    /** Surfaces both targets offer that no case compared. */
    no_cases: string[];
    contracts_not_compared: string[];
}

export interface Report {
    tool: "cmtk";
    mode: "run" | "compare";
    system: string;
    date: string;
    verdict: Verdict;
    targets: Record<string, string>;
    counts: Record<string, number>;
    cases: CaseOutcome[];
    contracts: ContractOutcome[];
    requirements: { requirement: string; cases: number; passed: number; failed: number; other: number }[];
    unused_drift: string[];
    /** cmtk run: the known-issues ledger as this run found it. */
    known_issues?: KnownIssueInReport[];
    /** cmtk run: ledger entries that no longer fail, for a person to remove. */
    stale_known_issues?: string[];
    suggested_scrubs: { where: string; cases: number; why: string }[];
    /** Only some cases ran (--only), so the verdict cannot be a pass. */
    partial: boolean;
    /** Draft cases left out with --accepted-only. */
    excluded_drafts?: number;
    /** cmtk run: cases on a surface listed under compare_only_surfaces. */
    excluded_compare_only?: number;
    /** Cases whose surface has no adapter, so nothing was sent for them. They count as errors, so the report can't pass. */
    no_adapter?: { surface: string; cases: string[] }[];
    /** cmtk compare: what the comparison covered, when a target lists its surfaces. */
    scope?: ReportScope;
    /** The settings that produced this report, so a signer sees exactly what was hidden or approved. */
    settings?: ReportSettings;
    /** cmtk compare: how many times each scrub rule changed something, including the ones that never did. */
    scrub_fired?: Record<string, number>;
    /** How many model calls produced this report, as the adapters counted them. HTTP cases make none. */
    model_calls?: { total: number; cases_not_counted: number };
    /** Why the verdict is what it is, in a sentence, and what to do next. */
    reason: string;
    next: string;
}
