import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

const BUILT_IN_AGENTS: AgentConfig[] = [
	{
		name: "scout",
		description:
			"Read-only codebase reconnaissance; returns concise findings with paths and evidence.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:scout",
		systemPrompt: [
			"You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.",
			"",
			"Your output will be passed to an agent who has NOT seen the files you explored.",
			"",
			"Do not edit files. Prefer read, grep, find, ls, and safe bash inspection commands.",
			"",
			"Thoroughness (infer from task, default medium):",
			"- Quick: Targeted lookups, key files only",
			"- Medium: Follow imports, read critical sections",
			"- Thorough: Trace all dependencies, check tests/types",
			"",
			"Strategy:",
			"1. grep/find to locate relevant code",
			"2. Read key sections (not entire files)",
			"3. Identify types, interfaces, key functions",
			"4. Note dependencies between files",
			"",
			"Output format:",
			"",
			"## Files Retrieved",
			"List with exact line ranges:",
			"1. `path/to/file.ts` (lines 10-50) - Description of what's here",
			"2. `path/to/other.ts` (lines 100-150) - Description",
			"3. ...",
			"",
			"## Key Code",
			"Critical types, interfaces, or functions:",
			"",
			"```typescript",
			"interface Example {",
			"  // actual code from the files",
			"}",
			"```",
			"",
			"```typescript",
			"function keyFunction() {",
			"  // actual implementation",
			"}",
			"```",
			"",
			"## Architecture",
			"Brief explanation of how the pieces connect.",
			"",
			"## Start Here",
			"Which file to look at first and why.",
		].join("\n"),
	},
	{
		name: "planner",
		description:
			"Turns reconnaissance into a lean implementation or migration plan.",
		tools: ["read", "grep", "find", "ls"],
		source: "built-in",
		filePath: "built-in:planner",
		systemPrompt: [
			"You are a planner subagent. Produce executable, verifiable plans only.",
			"Do not modify files. Ground the plan in the repository's actual structure.",
			"Call out assumptions, risks, sequencing, and verification commands.",
		].join("\n"),
	},
	{
		name: "reviewer",
		description:
			"Independent code review and verification agent for completed changes.",
		tools: ["read", "grep", "find", "ls", "bash"],
		source: "built-in",
		filePath: "built-in:reviewer",
		systemPrompt: [
			"You are a reviewer subagent. Review changes adversarially and verify claims.",
			"Do not edit files. Run safe inspection or test commands when useful.",
			"Report PASS, FAIL, or PARTIAL with evidence, commands run, and specific follow-ups.",
		].join("\n"),
	},
	{
		name: "worker",
		description:
			"General-purpose implementation worker with the default Pi tool set.",
		source: "built-in",
		filePath: "built-in:worker",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general",
		description: "Alias for worker; kept for model-generated subagent names.",
		source: "built-in",
		filePath: "built-in:general",
		systemPrompt: workerSystemPrompt(),
	},
	{
		name: "general-purpose",
		description:
			"Alias for worker; compatible with common subagent naming conventions.",
		source: "built-in",
		filePath: "built-in:general-purpose",
		systemPrompt: workerSystemPrompt(),
	},
];

function workerSystemPrompt(): string {
	return [
		"You are a focused worker subagent running in an isolated Pi process.",
		"Complete the delegated task directly. Keep scope tight and avoid unrelated changes.",
		"When done, summarize files changed, commands run, and any remaining risks.",
	].join("\n");
}

function loadAgentsFromDir(
	dir: string,
	source: Exclude<AgentSource, "built-in">,
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd = process.cwd()): AgentDiscoveryResult {
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = loadAgentsFromDir(userAgentsDir, "user");
	const projectAgents = projectAgentsDir
		? loadAgentsFromDir(projectAgentsDir, "project")
		: [];
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of BUILT_IN_AGENTS) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return {
		agents: Array.from(agentMap.values()),
		userAgentsDir,
		projectAgentsDir,
	};
}
