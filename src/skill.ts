// `termium --skill`: a SKILL.md for agents (Claude Code, Codex, any CLI
// agent), embedded in the binary.
import text from "./skill.md" with { type: "text" };

export const SKILL: string = text;
