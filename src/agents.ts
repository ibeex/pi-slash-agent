import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

const BUILT_IN_AGENTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"agents",
);

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
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

	const builtInAgents = loadAgentsFromDir(BUILT_IN_AGENTS_DIR, "built-in");

	for (const agent of builtInAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return {
		agents: Array.from(agentMap.values()),
		userAgentsDir,
		projectAgentsDir,
	};
}
