// Contract checks: what a consumer relies on must not break. The default for every contract is
// no change at all; additions are reported as compatible, removals and type changes as breaking.
import { parseXml } from "./diff.js";
import type { Contract, ContractFinding, ContractOutcome, Observation } from "./types.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

function schemaProps(doc: Json) {
    const schemas = obj(obj(doc.components).schemas ?? doc.definitions);
    const out = new Map<string, { props: Map<string, string>; required: Set<string> }>();
    for (const [name, s] of Object.entries(schemas)) {
        const props = new Map<string, string>();
        for (const [p, v] of Object.entries(obj(obj(s).properties))) props.set(p, String(obj(v).type ?? obj(v).$ref ?? ""));
        out.set(name, { props, required: new Set((obj(s).required as string[] | undefined) ?? []) });
    }
    return out;
}

export function diffOpenApi(a: Json, b: Json): ContractFinding[] {
    const f: ContractFinding[] = [];
    const ops = (d: Json) => {
        const m = new Map<string, Json>();
        for (const [p, item] of Object.entries(obj(d.paths))) for (const [verb, op] of Object.entries(obj(item))) if (METHODS.includes(verb)) m.set(`${verb.toUpperCase()} ${p}`, obj(op));
        return m;
    };
    const oa = ops(a), ob = ops(b);
    for (const k of [...oa.keys()].filter((k) => !ob.has(k)).sort()) f.push({ breaking: true, what: `operation removed: ${k}` });
    for (const k of [...ob.keys()].filter((k) => !oa.has(k)).sort()) f.push({ breaking: false, what: `operation added: ${k}` });
    for (const k of [...oa.keys()].filter((k) => ob.has(k)).sort()) {
        const pa = new Map<string, Json>(), pb = new Map<string, Json>();
        for (const p of (oa.get(k)!.parameters as Json[] | undefined) ?? []) pa.set(`${p.name} (${p.in})`, p);
        for (const p of (ob.get(k)!.parameters as Json[] | undefined) ?? []) pb.set(`${p.name} (${p.in})`, p);
        for (const [n, p] of pb) if (!pa.has(n) && p.required) f.push({ breaking: true, what: `${k}: new required parameter ${n}` });
        for (const n of pa.keys()) if (!pb.has(n)) f.push({ breaking: true, what: `${k}: parameter removed ${n}` });
        const ra = Object.keys(obj(oa.get(k)!.responses)), rb = new Set(Object.keys(obj(ob.get(k)!.responses)));
        for (const code of ra) if (!rb.has(code)) f.push({ breaking: true, what: `${k}: response ${code} removed` });
    }
    const sa = schemaProps(a), sb = schemaProps(b);
    for (const name of [...sa.keys()].sort()) {
        const x = sa.get(name)!, y = sb.get(name);
        if (!y) { f.push({ breaking: true, what: `schema removed: ${name}` }); continue; }
        for (const [p, t] of x.props) {
            if (!y.props.has(p)) f.push({ breaking: true, what: `schema ${name}: property removed ${p}` });
            else if (y.props.get(p) !== t) f.push({ breaking: true, what: `schema ${name}: property ${p} type ${t || "?"} → ${y.props.get(p) || "?"}` });
        }
        for (const p of y.required) if (!x.required.has(p)) f.push({ breaking: true, what: `schema ${name}: ${p} is now required` });
        for (const p of y.props.keys()) if (!x.props.has(p)) f.push({ breaking: false, what: `schema ${name}: property added ${p}` });
    }
    return f;
}

interface WsdlSummary {
    tns: Set<string>;
    ops: Set<string>;
    types: Map<string, Map<string, { type: string; min: string }>>;
}

function wsdlSummary(text: string): WsdlSummary {
    const root = parseXml(text);
    const out: WsdlSummary = { tns: new Set(), ops: new Set(), types: new Map() };
    const walk = (n: ReturnType<typeof parseXml>) => {
        const tns = n.attrs.get("targetNamespace");
        if (tns) out.tns.add(`${n.local}:${tns}`);
        const name = n.attrs.get("name");
        if (n.local === "operation" && name) out.ops.add(name);
        if ((n.local === "element" || n.local === "complexType") && name) {
            const kids = new Map<string, { type: string; min: string }>();
            const collect = (c: ReturnType<typeof parseXml>) => {
                for (const k of c.children) {
                    if (k.local === "element" && k.attrs.get("name")) kids.set(k.attrs.get("name")!, { type: k.attrs.get("type") ?? "", min: k.attrs.get("minOccurs") ?? "1" });
                    else collect(k);
                }
            };
            collect(n);
            const key = `${n.local} ${name}`;
            if (!out.types.has(key)) out.types.set(key, kids);
        }
        n.children.forEach(walk);
    };
    walk(root);
    return out;
}

export function diffWsdl(a: string, b: string): ContractFinding[] {
    const x = wsdlSummary(a), y = wsdlSummary(b);
    const f: ContractFinding[] = [];
    const local = (t: string) => t.split(":").pop() ?? t;
    for (const t of [...x.tns].filter((t) => !y.tns.has(t)).sort()) {
        const [where, ...ns] = t.split(":");
        f.push({ breaking: true, what: `target namespace no longer offered: ${ns.join(":")} (${where})` });
    }
    for (const op of [...x.ops].filter((o) => !y.ops.has(o)).sort()) f.push({ breaking: true, what: `operation removed: ${op}` });
    for (const op of [...y.ops].filter((o) => !x.ops.has(o)).sort()) f.push({ breaking: false, what: `operation added: ${op}` });
    for (const [owner, ka] of [...x.types].sort()) {
        const kb = y.types.get(owner);
        if (!kb) { f.push({ breaking: true, what: `${owner} removed` }); continue; }
        for (const [c, v] of ka) {
            if (!kb.has(c)) f.push({ breaking: true, what: `${owner}: element ${c} removed` });
            else if (local(kb.get(c)!.type) !== local(v.type)) f.push({ breaking: true, what: `${owner}: element ${c} type ${v.type} → ${kb.get(c)!.type}` });
        }
        for (const [c, v] of kb) {
            if (!ka.has(c)) {
                const required = v.min !== "0";
                f.push({ breaking: required, what: `${owner}: element ${c} added${required ? " (required)" : ""}` });
            }
        }
    }
    return f;
}

export function checkContract(c: Contract, ref: Observation, cand: Observation): ContractOutcome {
    const base = { name: c.name, kind: c.kind };
    for (const [side, r] of [["reference", ref], ["candidate", cand]] as const) {
        if (r.error) return { ...base, result: "ERROR", findings: [{ breaking: false, what: `${side}: ${r.error}` }] };
        if (r.status !== 200) return { ...base, result: "ERROR", findings: [{ breaking: false, what: `${side} answered HTTP ${r.status}` }] };
    }
    let findings: ContractFinding[] = [];
    try {
        const kind = c.kind.toLowerCase();
        if (kind === "openapi") findings = diffOpenApi(JSON.parse(ref.body ?? ""), JSON.parse(cand.body ?? ""));
        else if (kind === "wsdl" || kind === "xsd") findings = diffWsdl(ref.body ?? "", cand.body ?? "");
        else if (ref.sha256 !== cand.sha256) findings = [{ breaking: null, what: "the text differs; this kind is not analysed, so a person must review it" }];
    } catch (err) {
        return { ...base, result: "ERROR", findings: [{ breaking: false, what: `could not parse: ${(err as Error).message}` }] };
    }
    const result = findings.some((x) => x.breaking === true) ? "BREAKING"
        : findings.some((x) => x.breaking === null) ? "REVIEW"
        : findings.length ? "COMPATIBLE"
        : ref.sha256 === cand.sha256 ? "IDENTICAL" : "EQUIVALENT";
    return { ...base, result, findings };
}
