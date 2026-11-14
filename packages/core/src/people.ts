// Who may stand behind a decision. This catches an agent that writes its own name honestly, and a person who
// mistypes one. It is not an identity check: a name in a file is only a name. See "What the terminal check does
// and does not stop" in docs/TEST-PLAN.md.

/** Tools and roles written as if they were a person. Compared with the whole name, because Claude and Gemma can be people. */
const TOOL_NAMES = /^(ai|a\.i\.|bot|llm|ml|model|assistant|ai assistant|automation|automated|script|system|ci|ci\/cd|pipeline|github actions|claude|claude code|anthropic|copilot|github copilot|chatgpt|openai|gpt|gemini|cursor|codex|cmtk)$/;

/** Does this read as an agent, a bot or a tool, rather than a person? */
export function looksLikeAgent(name: string): boolean {
    const n = name.trim().toLowerCase().replace(/\s+/g, " ");
    return /\bagents?\b/.test(n)
        || /\bbots?\b/.test(n) || /\[bot\]/.test(n)
        || /\bcopilot\b|\bchatgpt\b|\bgpt-?\d/.test(n)
        || /^claude[-:[(]/.test(n) || /^claude (code|opus|sonnet|haiku)\b/.test(n)
        || TOOL_NAMES.test(n);
}
