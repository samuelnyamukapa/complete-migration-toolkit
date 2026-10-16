// The shapes every part of the toolkit shares. Plain data, so a person can read and edit
// every file the toolkit writes, and an adapter in any language can produce them.

/** How strict a comparison is. Set for the whole system, then loosened per path or per case. */
export type MatchLevel = "exact" | "semantic" | "contract";
export const MATCH_LEVELS: readonly MatchLevel[] = ["exact", "semantic", "contract"];

/** One system the toolkit can send cases to. */
export interface Target {
    name: string;
    base_url: string;
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
    evidence: string;
    allow_unsafe_methods: boolean;
    /** Header name to environment variable name. Values are read at run time and never written. */
    headers_from_env: Record<string, string>;
    timeout_s: number;
    insecure_tls: boolean;
    /** Adapters beyond the built-in http one: surface name to the program that runs it. */
    adapters: Record<string, { command: string; args?: string[] }>;
    /** Folder the manifest lives in; every relative path is resolved against it. */
    root: string;
}

export interface Request {
    method: string;
    /** A path only, never a host: requests go to a target's base URL. */
    path: string;
    headers?: Record<string, string>;
    body?: string | null;
}

/** A check on one answer, for `cmtk run`. Every field is optional. */
export interface Expectation {
    status?: number | number[];
    headers?: Record<string, string | { matches: string }>;
    /** JSON path to a check. */
    json?: Record<string, JsonCheck>;
    body_contains?: string[];
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
}

/** What one target answered to one case. Adapters return this shape. */
export interface Observation {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    sha256?: string;
    truncated?: boolean;
    /** Side effects an adapter observed: emails, messages, rows, files. Compared like a JSON body. */
    effects?: Record<string, unknown>;
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

export type CaseResult =
    | "PASS" | "FAIL"            // cmtk run
    | "MATCH" | "DRIFT" | "DIFFERENT" // cmtk compare (DRIFT: only approved differences)
    | "SKIPPED" | "ERROR";

export interface Failure {
    check: string;
    expected: string;
    actual: string;
}

export interface CaseOutcome {
    id: string;
    name: string;
    requirement: string[];
    surface: string;
    match?: MatchLevel;
    result: CaseResult;
    why?: string;
    failures?: Failure[];
    differences?: Difference[];
    note?: string;
}

export interface ContractFinding {
    /** true breaks consumers; false is compatible; null needs a person. */
    breaking: boolean | null;
    what: string;
}

export interface ContractOutcome {
    name: string;
    kind: string;
    result: "IDENTICAL" | "EQUIVALENT" | "COMPATIBLE" | "BREAKING" | "REVIEW" | "ERROR";
    findings: ContractFinding[];
}

export type Verdict =
    | "PASS" | "FAIL"                       // cmtk run
    | "PARITY" | "DRIFT ONLY" | "NO PARITY"  // cmtk compare
    | "INCOMPLETE" | "NO EVIDENCE";

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
    suggested_scrubs: { where: string; cases: number; why: string }[];
    partial: boolean;
}
