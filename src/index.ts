import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	type AgentConfig,
	type AgentSource,
	discoverAgents,
} from "./agents.js";

const DEFAULT_TIMEOUT_MS =
	parsePositiveInteger(process.env.PI_SLASH_AGENT_TIMEOUT_MS) ?? 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const HARD_KILL_EXTRA_GRACE_MS = 2000;
const MAX_STDERR_CHARS = 16 * 1024;
const MAX_STDOUT_PARSE_WARNINGS = 5;
const STATUS_KEY = "subagent";
const WIDGET_KEY = "subagent-live";
const COLLAPSED_OUTPUT_PREVIEW_MAX_CHARS = 480;
const COLLAPSED_OUTPUT_PREVIEW_MAX_LINES = 10;
const LIVE_ACTIVITY_ITEM_COUNT = 4;

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface ActiveToolCall {
	toolCallId?: string;
	name: string;
	args: Record<string, unknown>;
	startedAt: number;
	updateCount: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	stderr: string;
	stderrTruncated?: boolean;
	stdoutParseWarnings: number;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	finalOutput: string;
	displayItems: DisplayItem[];
	activeToolCall?: ActiveToolCall;
	completedToolCalls: number;
	timedOut?: boolean;
	timeoutMs: number;
	startedAt: number;
	lastEventAt: number;
	completedAt?: number;
	pid?: number;
	invocation?: string;
}

interface SubagentListDetails {
	agents: AgentConfig[];
	userAgentsDir: string;
	projectAgentsDir: string | null;
}

interface HandoffBuffer {
	sourceAgent: string;
	sourceTask: string;
	output: string;
	savedAt: number;
}

interface HandoffStatusDetails {
	action: "show" | "saved" | "used" | "cleared";
	handoff?: HandoffBuffer;
	targetAgent?: string;
}

function createUsageStats(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatElapsed(result: SingleResult): string {
	const end = result.completedAt ?? Date.now();
	return formatDuration(end - result.startedAt);
}

function appendLimitedStderr(result: SingleResult, text: string): void {
	if (!text) return;
	const combined = result.stderr + text;
	if (combined.length <= MAX_STDERR_CHARS) {
		result.stderr = combined;
		return;
	}
	result.stderr = combined.slice(combined.length - MAX_STDERR_CHARS);
	result.stderrTruncated = true;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (
		color: "muted" | "toolOutput" | "accent" | "dim",
		text: string,
	) => string,
): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const filePath = shortenPath(
				((args.file_path || args.path || "...") as string) || "...",
			);
			return themeFg("muted", "read ") + themeFg("accent", filePath);
		}
		case "write": {
			const filePath = shortenPath(
				((args.file_path || args.path || "...") as string) || "...",
			);
			return themeFg("muted", "write ") + themeFg("accent", filePath);
		}
		case "edit": {
			const filePath = shortenPath(
				((args.file_path || args.path || "...") as string) || "...",
			);
			return themeFg("muted", "edit ") + themeFg("accent", filePath);
		}
		case "ls": {
			const filePath = shortenPath(((args.path || ".") as string) || ".");
			return themeFg("muted", "ls ") + themeFg("accent", filePath);
		}
		case "find": {
			const pattern = ((args.pattern || "*") as string) || "*";
			const filePath = shortenPath(((args.path || ".") as string) || ".");
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${filePath}`)
			);
		}
		case "grep": {
			const pattern = ((args.pattern || "") as string) || "";
			const filePath = shortenPath(((args.path || ".") as string) || ".");
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${filePath}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function countToolCalls(items: DisplayItem[]): number {
	return items.filter((item) => item.type === "toolCall").length;
}

function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function stripMarkdownForPreview(text: string): string {
	let result = text.replace(/\r\n?/g, "\n").trim();
	result = result.replace(/```([\s\S]*?)```/g, (_match, code: string) =>
		code.trim(),
	);
	result = result.replace(/^#{1,6}\s+/gm, "");
	result = result.replace(/^>\s?/gm, "");
	result = result.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "• ");
	result = result.replace(/^\s*[-*+]\s+/gm, "• ");
	result = result.replace(/^\s*\d+\.\s+/gm, "");
	result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
	result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	result = result.replace(/`([^`]+)`/g, "$1");
	result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
	result = result.replace(/~~(.*?)~~/g, "$1");
	result = result.replace(
		/(^|[\s(])([*_])([^*_\n]+)\2(?=[\s).,!?:;]|$)/g,
		"$1$3",
	);
	result = result.replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, "");
	result = result.replace(/\|/g, " ");
	result = result.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "");
	result = result.replace(/\\(\[|\]|[`*_{}()#+.!|>-])/g, "$1");
	return collapseWhitespace(result);
}

function truncateMultilineText(
	text: string,
	maxChars: number,
	maxLines: number,
): { text: string; truncated: boolean } {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return { text: "", truncated: false };

	const lines = normalized.split("\n");
	let preview = lines.slice(0, maxLines).join("\n");
	let truncated = lines.length > maxLines;

	if (preview.length > maxChars) {
		preview = preview.slice(0, maxChars).trimEnd();
		truncated = true;
	}
	if (!truncated) return { text: preview, truncated: false };

	const fenceCount = (preview.match(/```/g) ?? []).length;
	if (fenceCount % 2 === 1) preview = `${preview}\n\`\`\``;
	return { text: `${preview.trimEnd()}\n\n…`, truncated: true };
}

function getCollapsedOutputPreview(text: string): {
	text: string;
	truncated: boolean;
} {
	return truncateMultilineText(
		text,
		COLLAPSED_OUTPUT_PREVIEW_MAX_CHARS,
		COLLAPSED_OUTPUT_PREVIEW_MAX_LINES,
	);
}

function formatTaskPreview(task: string): string {
	return truncateText(collapseWhitespace(task), 96);
}

function formatSavedAge(savedAt: number): string {
	return formatDuration(Math.max(0, Date.now() - savedAt));
}

function getResultState(result: SingleResult): {
	label: string;
	color: "success" | "warning" | "error";
} {
	if (result.exitCode === -1) {
		return { label: "running", color: "warning" };
	}
	if (result.exitCode === 0 && !result.timedOut) {
		return { label: "completed", color: "success" };
	}
	if (result.timedOut) {
		return { label: "timed out", color: "warning" };
	}
	if (result.stopReason === "aborted") {
		return { label: "aborted", color: "warning" };
	}
	return { label: "failed", color: "error" };
}

function getResultSummaryPreview(result: SingleResult): string {
	const source = result.finalOutput
		? stripMarkdownForPreview(result.finalOutput)
		: result.errorMessage || result.stderr.trim() || "(no output)";
	return truncateText(collapseWhitespace(source), 220);
}

function formatResultMeta(result: SingleResult): string {
	const parts: string[] = [];
	parts.push(`elapsed ${formatElapsed(result)}`);
	const toolCalls = Math.max(
		result.completedToolCalls,
		countToolCalls(result.displayItems),
	);
	if (toolCalls > 0) parts.push(pluralize(toolCalls, "tool call"));
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) parts.push(usage);
	if (result.stdoutParseWarnings > 0)
		parts.push(
			`${result.stdoutParseWarnings} non-json stdout line${result.stdoutParseWarnings === 1 ? "" : "s"}`,
		);
	if (result.timedOut)
		parts.push(`timeout ${Math.ceil(result.timeoutMs / 1000)}s`);
	return parts.join(" · ");
}

function getAssistantTextContent(message: Message): string {
	if (!Array.isArray(message.content)) return "";
	const textParts: string[] = [];
	for (const part of message.content) {
		if (part.type !== "text") continue;
		const text = part.text.trim();
		if (text) textParts.push(text);
	}
	return textParts.join("\n\n");
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = getAssistantTextContent(msg);
		if (text) return text;
	}
	return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall")
				items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-slash-agent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function signalProcess(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
	if (proc.exitCode !== null || proc.signalCode !== null) return;
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// Fall back to the direct child if process-group signalling fails.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// Ignore races with process exit.
	}
}

function terminateProcess(proc: ReturnType<typeof spawn>): NodeJS.Timeout {
	signalProcess(proc, "SIGTERM");
	const killTimer = setTimeout(() => {
		signalProcess(proc, "SIGKILL");
	}, KILL_GRACE_MS);
	killTimer.unref();
	return killTimer;
}

function createEmptyResult(
	agent: string,
	agentSource: AgentSource | "unknown",
	task: string,
	timeoutMs: number,
): SingleResult {
	const now = Date.now();
	return {
		agent,
		agentSource,
		task,
		exitCode: -1,
		stderr: "",
		stdoutParseWarnings: 0,
		usage: createUsageStats(),
		finalOutput: "",
		displayItems: [],
		completedToolCalls: 0,
		timeoutMs,
		startedAt: now,
		lastEventAt: now,
	};
}

async function runSubagent(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	timeoutMs: number,
	currentSessionModel?: string,
	onUpdate?: (result: SingleResult) => void,
): Promise<SingleResult> {
	const agent = agents.find((entry) => entry.name === agentName);
	if (!agent) {
		const available =
			agents.map((entry) => `"${entry.name}"`).join(", ") || "none";
		const result = createEmptyResult(agentName, "unknown", task, timeoutMs);
		result.exitCode = 1;
		result.completedAt = Date.now();
		appendLimitedStderr(
			result,
			`Unknown agent: "${agentName}". Available agents: ${available}.`,
		);
		return result;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (currentSessionModel) args.push("--model", currentSessionModel);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const messages: Message[] = [];
	const result: SingleResult = createEmptyResult(
		agent.name,
		agent.source,
		task,
		timeoutMs,
	);
	result.model = currentSessionModel;
	const emitUpdate = () => {
		result.lastEventAt = Date.now();
		onUpdate?.({ ...result, displayItems: [...result.displayItems] });
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		emitUpdate();

		result.exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			result.invocation = `${invocation.command} ${invocation.args.join(" ")}`;

			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd,
					detached: process.platform !== "win32",
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.errorMessage = message;
				appendLimitedStderr(result, message);
				emitUpdate();
				resolve(1);
				return;
			}

			result.pid = proc.pid;
			let buffer = "";
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;
			let hardFinishTimer: NodeJS.Timeout | undefined;
			const timeout = setTimeout(() => {
				result.timedOut = true;
				result.stopReason = "timeout";
				result.errorMessage = `Subagent timed out after ${timeoutMs}ms`;
				appendLimitedStderr(
					result,
					`${result.stderr ? "\n" : ""}Subagent timed out after ${timeoutMs}ms.`,
				);
				emitUpdate();
				killTimer = terminateProcess(proc);
				hardFinishTimer = setTimeout(() => {
					finish(124);
				}, KILL_GRACE_MS + HARD_KILL_EXTRA_GRACE_MS);
				hardFinishTimer.unref();
			}, timeoutMs);
			timeout.unref();

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				if (hardFinishTimer) clearTimeout(hardFinishTimer);
				result.completedAt = Date.now();
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					result.stdoutParseWarnings++;
					if (result.stdoutParseWarnings <= MAX_STDOUT_PARSE_WARNINGS) {
						appendLimitedStderr(
							result,
							`${result.stderr ? "\n" : ""}Non-JSON stdout from subagent: ${truncateText(line, 240)}`,
						);
					}
					emitUpdate();
					return;
				}
				if (!event || typeof event !== "object") return;

				const parsed = event as {
					type?: unknown;
					message?: unknown;
					toolCallId?: unknown;
					toolName?: unknown;
					args?: unknown;
				};

				if (parsed.type === "message_end" && parsed.message) {
					const msg = parsed.message as Message;
					messages.push(msg);
					result.finalOutput = getFinalOutput(messages);
					result.displayItems = getDisplayItems(messages);

					if (msg.role === "assistant") {
						result.usage.turns++;
						if (msg.usage) {
							result.usage.input += msg.usage.input || 0;
							result.usage.output += msg.usage.output || 0;
							result.usage.cacheRead += msg.usage.cacheRead || 0;
							result.usage.cacheWrite += msg.usage.cacheWrite || 0;
							result.usage.cost += msg.usage.cost?.total || 0;
							result.usage.contextTokens = msg.usage.totalTokens || 0;
						}
						if (!result.model && msg.model) result.model = msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					emitUpdate();
					return;
				}

				if (parsed.type === "tool_execution_start") {
					result.activeToolCall = {
						toolCallId:
							typeof parsed.toolCallId === "string"
								? parsed.toolCallId
								: undefined,
						name:
							typeof parsed.toolName === "string" ? parsed.toolName : "tool",
						args: asRecord(parsed.args),
						startedAt: Date.now(),
						updateCount: 0,
					};
					emitUpdate();
					return;
				}

				if (parsed.type === "tool_execution_update") {
					if (result.activeToolCall) result.activeToolCall.updateCount++;
					emitUpdate();
					return;
				}

				if (parsed.type === "tool_execution_end") {
					result.completedToolCalls++;
					if (
						result.activeToolCall &&
						typeof parsed.toolCallId === "string" &&
						result.activeToolCall.toolCallId === parsed.toolCallId
					) {
						result.activeToolCall = undefined;
					} else if (
						result.activeToolCall &&
						typeof parsed.toolName === "string" &&
						result.activeToolCall.name === parsed.toolName
					) {
						result.activeToolCall = undefined;
					}
					emitUpdate();
				}
			};

			proc.stdout?.setEncoding("utf8");
			proc.stderr?.setEncoding("utf8");

			proc.stdout?.on("data", (data: string) => {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (data: string) => {
				appendLimitedStderr(result, data);
				emitUpdate();
			});

			proc.on("close", (code, signal) => {
				if (buffer.trim()) processLine(buffer);
				if (signal && !result.timedOut && !result.stopReason) {
					result.stopReason = signal;
				}
				finish(result.timedOut ? 124 : (code ?? (signal ? 128 : 0)));
			});

			proc.on("error", (error) => {
				result.errorMessage = error.message;
				appendLimitedStderr(
					result,
					`${result.stderr ? "\n" : ""}${error.message}`,
				);
				emitUpdate();
				finish(1);
			});
		});

		result.activeToolCall = undefined;
		result.finalOutput = getFinalOutput(messages);
		result.displayItems = getDisplayItems(messages);
		if (result.exitCode !== 0 && !result.errorMessage) {
			result.errorMessage = `Subagent exited with code ${result.exitCode}`;
		}
		if (!result.completedAt) result.completedAt = Date.now();
		return result;
	} finally {
		if (tmpPromptDir) {
			try {
				await fs.promises.rm(tmpPromptDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	}
}

function parseCommandArgs(
	args: string,
): { agent: string; task: string; noHandoff: boolean } | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const firstSpace = trimmed.search(/\s/);
	if (firstSpace === -1) return undefined;
	const agent = trimmed.slice(0, firstSpace).trim();
	let remainder = trimmed.slice(firstSpace + 1).trim();
	if (!agent || !remainder) return undefined;

	let noHandoff = false;
	while (true) {
		if (remainder === "--no-handoff") {
			noHandoff = true;
			remainder = "";
			break;
		}
		if (remainder.startsWith("--no-handoff ")) {
			noHandoff = true;
			remainder = remainder.slice("--no-handoff".length).trim();
			continue;
		}
		break;
	}

	const task = remainder.trim();
	if (!task) return undefined;
	return { agent, task, noHandoff };
}

function parseTaskArgs(args: string): string | undefined {
	const task = args.trim();
	return task ? task : undefined;
}

function didSubagentFail(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.timedOut === true ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function formatHandoffOutput(label: string, output: string): string {
	const trimmed = output.trim();
	return trimmed || `(${label} returned no final output)`;
}

function canonicalAgentName(agentName: string): string {
	switch (agentName) {
		case "general":
		case "general-purpose":
			return "worker";
		default:
			return agentName;
	}
}

function buildPlannerTask(originalTask: string, scoutOutput: string): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Context from scout:",
		formatHandoffOutput("scout", scoutOutput),
	].join("\n");
}

function buildWorkerTask(
	originalTask: string,
	scoutOutput: string,
	plannerOutput: string,
): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Context from scout:",
		formatHandoffOutput("scout", scoutOutput),
		"",
		"Implementation plan from planner:",
		formatHandoffOutput("planner", plannerOutput),
	].join("\n");
}

function buildWorkerTaskFromScout(
	originalTask: string,
	scoutOutput: string,
): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Context from scout:",
		formatHandoffOutput("scout", scoutOutput),
		"",
		"Use the scout context above to implement the request.",
	].join("\n");
}

function buildWorkerTaskFromPlanner(
	originalTask: string,
	plannerOutput: string,
): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Implementation plan from planner:",
		formatHandoffOutput("planner", plannerOutput),
		"",
		"Implement the request by following the plan above.",
	].join("\n");
}

function buildReviewerTask(originalTask: string, workerOutput: string): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Implementation summary from worker:",
		formatHandoffOutput("worker", workerOutput),
		"",
		"Review the implementation for correctness, quality, and risk. Do not modify files.",
	].join("\n");
}

function buildWorkerTaskFromReviewer(
	originalTask: string,
	reviewerOutput: string,
): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Review feedback from reviewer:",
		formatHandoffOutput("reviewer", reviewerOutput),
		"",
		"Apply the reviewer feedback where appropriate, then summarize the final changes.",
	].join("\n");
}

function buildRevisionTask(
	originalTask: string,
	workerOutput: string,
	reviewerOutput: string,
): string {
	return [
		"Original request:",
		originalTask.trim(),
		"",
		"Previous implementation summary from worker:",
		formatHandoffOutput("worker", workerOutput),
		"",
		"Review feedback from reviewer:",
		formatHandoffOutput("reviewer", reviewerOutput),
		"",
		"Apply the reviewer feedback where appropriate, then summarize the final changes.",
	].join("\n");
}

function buildTaskFromHandoff(
	targetAgentName: string,
	originalTask: string,
	handoff: HandoffBuffer,
): string | undefined {
	const target = canonicalAgentName(targetAgentName);
	const source = canonicalAgentName(handoff.sourceAgent);
	if (!handoff.output.trim()) return undefined;

	switch (target) {
		case "planner":
			return source === "scout"
				? buildPlannerTask(originalTask, handoff.output)
				: undefined;
		case "worker":
			if (source === "scout") {
				return buildWorkerTaskFromScout(originalTask, handoff.output);
			}
			if (source === "planner") {
				return buildWorkerTaskFromPlanner(originalTask, handoff.output);
			}
			if (source === "reviewer") {
				return buildWorkerTaskFromReviewer(originalTask, handoff.output);
			}
			return undefined;
		case "reviewer":
			return source === "worker"
				? buildReviewerTask(originalTask, handoff.output)
				: undefined;
		default:
			return undefined;
	}
}

function getAgentAutocompleteScore(agent: AgentConfig, query: string): number {
	if (!query) return 1000;

	const normalizedQuery = query.toLowerCase();
	const name = agent.name.toLowerCase();
	const description = agent.description.toLowerCase();

	if (name === normalizedQuery) return 500;
	if (name.startsWith(normalizedQuery)) return 400;
	if (name.split(/[-_]/).some((part) => part.startsWith(normalizedQuery))) {
		return 300;
	}
	if (name.includes(normalizedQuery)) return 250;
	if (description.includes(normalizedQuery)) return 100;
	return -1;
}

function makeAgentCompletions(prefix: string): AutocompleteItem[] | null {
	const raw = prefix.trimStart();
	if (/\s/.test(raw)) return null;

	const items = discoverAgents()
		.agents.map((agent) => ({
			agent,
			score: getAgentAutocompleteScore(agent, raw),
		}))
		.filter((entry) => entry.score >= 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.agent.name.localeCompare(b.agent.name) ||
				a.agent.source.localeCompare(b.agent.source),
		)
		.map(({ agent }) => {
			const toolsPreview = agent.tools?.length
				? ` • tools: ${agent.tools.slice(0, 4).join(", ")}${agent.tools.length > 4 ? ", ..." : ""}`
				: "";
			return {
				value: `${agent.name} `,
				label: `${agent.name} (${agent.source})`,
				description: `${agent.description}${toolsPreview}`,
			};
		});

	return items.length > 0 ? items : null;
}

export default function slashSubagentExtension(pi: ExtensionAPI) {
	let handoffBuffer: HandoffBuffer | undefined;

	pi.registerMessageRenderer(
		"handoff-status",
		(message, { expanded }, theme) => {
			const details = message.details as HandoffStatusDetails | undefined;
			const handoff = details?.handoff;
			const fallbackContent =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			const box = new Box(1, 1, (inner) => theme.bg("customMessageBg", inner));
			const container = new Container();
			const title =
				details?.action === "cleared"
					? "Handoff cleared"
					: details?.action === "saved"
						? "Handoff saved"
						: details?.action === "used"
							? "Handoff used"
							: "Handoff";
			container.addChild(
				new Text(theme.fg("toolTitle", theme.bold(title)), 0, 0),
			);
			container.addChild(
				new Text(theme.fg("dim", fallbackContent || "(no details)"), 0, 0),
			);

			if (expanded && handoff) {
				const mdTheme = getMarkdownTheme();
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Source:"), 0, 0));
				container.addChild(
					new Text(
						theme.fg("accent", handoff.sourceAgent) +
							theme.fg(
								"dim",
								` · saved ${formatSavedAge(handoff.savedAt)} ago`,
							),
						0,
						0,
					),
				);
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "Task:"), 0, 0));
				container.addChild(new Text(theme.fg("dim", handoff.sourceTask), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", "Output preview:"), 0, 0),
				);
				const preview = getCollapsedOutputPreview(handoff.output);
				container.addChild(new Markdown(preview.text, 0, 0, mdTheme));
				if (preview.truncated) {
					container.addChild(
						new Text(theme.fg("muted", "(preview truncated)"), 0, 0),
					);
				}
			}

			box.addChild(container);
			return box;
		},
	);

	pi.registerMessageRenderer(
		"subagent-list",
		(message, { expanded }, theme) => {
			const details = message.details as SubagentListDetails | undefined;
			const agents = details?.agents ?? [];
			const builtIns = agents.filter((agent) => agent.source === "built-in");
			const userAgents = agents.filter((agent) => agent.source === "user");
			const projectAgents = agents.filter(
				(agent) => agent.source === "project",
			);

			let text = `${theme.fg("toolTitle", theme.bold("Available subagents"))}`;
			if (expanded && details?.projectAgentsDir) {
				text += `\n${theme.fg("muted", `project: ${shortenPath(details.projectAgentsDir)}`)}`;
			}
			if (expanded && details?.userAgentsDir) {
				text += `\n${theme.fg("muted", `user: ${shortenPath(details.userAgentsDir)}`)}`;
			}
			const renderGroup = (title: string, list: AgentConfig[]) => {
				if (list.length === 0) return;
				text += `\n\n${theme.fg("muted", title)}`;
				for (const agent of list) {
					text += `\n${theme.fg("accent", agent.name)} ${theme.fg("dim", agent.description)}`;
					if (expanded) {
						text += `\n  ${theme.fg("muted", shortenPath(agent.filePath))}`;
						if (agent.tools && agent.tools.length > 0) {
							text += `\n  ${theme.fg("muted", `tools: ${agent.tools.join(", ")}`)}`;
						}
					}
				}
			};

			renderGroup("Project (.pi/agents)", projectAgents);
			renderGroup("User", userAgents);
			renderGroup("Built-in", builtIns);

			const box = new Box(1, 1, (inner) => theme.bg("customMessageBg", inner));
			box.addChild(new Text(text, 0, 0));
			return box;
		},
	);

	pi.registerMessageRenderer("subagent-run", (message, { expanded }, theme) => {
		const details = message.details as SingleResult | undefined;
		if (!details) {
			const fallbackContent =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			const box = new Box(1, 1, (inner) => theme.bg("customMessageBg", inner));
			box.addChild(new Text(fallbackContent || "(no output)", 0, 0));
			return box;
		}

		const isError =
			details.exitCode !== 0 ||
			details.stopReason === "error" ||
			details.stopReason === "aborted";
		const state = getResultState(details);
		const summary = getResultSummaryPreview(details);
		const taskPreview = formatTaskPreview(details.task);
		const meta = formatResultMeta(details);
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))}${theme.fg("muted", ` (${details.agentSource})`)} ${theme.fg(state.color, state.label)}`;
		const mdTheme = getMarkdownTheme();
		const summaryColor = isError ? state.color : "toolOutput";
		const toolCallCount = countToolCalls(details.displayItems);

		const box = new Box(1, 1, (inner) => theme.bg("customMessageBg", inner));

		if (!expanded) {
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("dim", taskPreview), 0, 0));

			if (details.finalOutput.trim()) {
				const preview = getCollapsedOutputPreview(details.finalOutput);
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(preview.text, 0, 0, mdTheme));
				if (preview.truncated) {
					container.addChild(
						new Text(theme.fg("muted", "(expand for full output)"), 0, 0),
					);
				}
			} else {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("muted", "summary: ") + theme.fg(summaryColor, summary),
						0,
						0,
					),
				);
			}

			if (meta) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", meta), 0, 0));
			}

			box.addChild(container);
			return box;
		}

		const container = new Container();
		container.addChild(new Text(header, 0, 0));
		if (meta) container.addChild(new Text(theme.fg("dim", meta), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Task:"), 0, 0));
		container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Summary:"), 0, 0));
		container.addChild(new Text(theme.fg(summaryColor, summary), 0, 0));

		if (details.errorMessage) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0),
			);
		}
		if (toolCallCount > 0) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg(
						"muted",
						`Tool calls (${pluralize(toolCallCount, "call")}):`,
					),
					0,
					0,
				),
			);
			for (const item of details.displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") +
								formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
				}
			}
		}
		if (details.finalOutput.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Output:"), 0, 0));
			container.addChild(
				new Markdown(details.finalOutput.trim(), 0, 0, mdTheme),
			);
		}
		if (details.stderr.trim()) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "stderr:"), 0, 0));
			container.addChild(
				new Text(theme.fg("error", details.stderr.trim()), 0, 0),
			);
		}
		if (
			!details.finalOutput.trim() &&
			!details.stderr.trim() &&
			!details.errorMessage
		) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		}

		box.addChild(container);
		return box;
	});

	pi.registerCommand("subagents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const discovery = discoverAgents(ctx.cwd);
			const agents = discovery.agents;
			pi.sendMessage({
				customType: "subagent-list",
				content: `Found ${agents.length} subagent${agents.length === 1 ? "" : "s"}.`,
				display: true,
				details: {
					agents,
					userAgentsDir: discovery.userAgentsDir,
					projectAgentsDir: discovery.projectAgentsDir,
				} satisfies SubagentListDetails,
			});
		},
	});

	const queueWarning =
		"New prompts you send now will queue until this subagent finishes.";

	const sendHandoffStatus = (
		action: HandoffStatusDetails["action"],
		handoff?: HandoffBuffer,
		targetAgent?: string,
	) => {
		let content: string;
		if (action === "cleared") {
			content = "Cleared the saved handoff buffer.";
		} else if (!handoff) {
			content = "No saved handoff.";
		} else if (action === "saved") {
			content = `Saved handoff from ${handoff.sourceAgent}.`;
		} else if (action === "used") {
			content = `Using saved handoff from ${handoff.sourceAgent} for ${targetAgent ?? "the next step"}.`;
		} else {
			content = `Saved handoff from ${handoff.sourceAgent}, ${formatSavedAge(handoff.savedAt)} ago.`;
		}
		pi.sendMessage({
			customType: "handoff-status",
			content,
			display: true,
			details: {
				action,
				handoff,
				targetAgent,
			} satisfies HandoffStatusDetails,
		});
	};

	const saveHandoffFromResult = (
		result: SingleResult,
		announce = true,
	): void => {
		if (didSubagentFail(result)) return;
		const output = result.finalOutput.trim();
		if (!output) return;
		handoffBuffer = {
			sourceAgent: result.agent,
			sourceTask: result.task,
			output,
			savedAt: Date.now(),
		};
		if (announce) sendHandoffStatus("saved", handoffBuffer);
	};

	const getCurrentSessionModel = (ctx: ExtensionCommandContext) =>
		ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	const clearLiveSubagentUI = (ctx: ExtensionCommandContext) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingMessage();
	};

	const sendSubagentResult = (result: SingleResult) => {
		const summary = getResultSummaryPreview(result);
		pi.sendMessage({
			customType: "subagent-run",
			content: summary,
			display: true,
			details: result,
		});
	};

	const updateLiveSubagentUI = (
		commandCtx: ExtensionCommandContext,
		result: SingleResult,
	) => {
		const statusParts = [
			commandCtx.ui.theme.fg("warning", "⏳"),
			commandCtx.ui.theme.fg("accent", `subagent ${result.agent}`),
			commandCtx.ui.theme.fg("dim", formatElapsed(result)),
		];
		if (result.activeToolCall) {
			statusParts.push(
				commandCtx.ui.theme.fg(
					"dim",
					formatToolCall(
						result.activeToolCall.name,
						result.activeToolCall.args,
						commandCtx.ui.theme.fg.bind(commandCtx.ui.theme),
					),
				),
			);
		} else if (result.displayItems.length > 0) {
			statusParts.push(commandCtx.ui.theme.fg("dim", formatResultMeta(result)));
		} else {
			statusParts.push(commandCtx.ui.theme.fg("dim", "starting..."));
		}
		commandCtx.ui.setStatus(STATUS_KEY, statusParts.filter(Boolean).join(" "));
		commandCtx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
			const box = new Box(1, 1, (inner) => theme.bg("customMessageBg", inner));
			const container = new Container();
			const pidText = result.pid ? ` pid:${result.pid}` : "";
			const header = `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold(`Subagent ${result.agent}`))}${theme.fg("muted", ` (${result.agentSource})`)} ${theme.fg("dim", `elapsed ${formatElapsed(result)}${pidText}`)}`;
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("warning", queueWarning), 0, 0));
			if (result.agentSource === "project") {
				container.addChild(
					new Text(
						theme.fg("warning", "Using project-local agent from .pi/agents"),
						0,
						0,
					),
				);
			}
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Task:"), 0, 0));
			container.addChild(new Text(theme.fg("dim", result.task), 0, 0));

			const activityLines: string[] = [];
			if (result.activeToolCall) {
				activityLines.push(
					theme.fg("muted", "→ ") +
						formatToolCall(
							result.activeToolCall.name,
							result.activeToolCall.args,
							theme.fg.bind(theme),
						) +
						theme.fg(
							"warning",
							` (running ${formatDuration(Date.now() - result.activeToolCall.startedAt)})`,
						),
				);
			}
			for (const item of result.displayItems.slice(-LIVE_ACTIVITY_ITEM_COUNT)) {
				if (item.type === "toolCall") {
					activityLines.push(
						theme.fg("muted", "→ ") +
							formatToolCall(item.name, item.args, theme.fg.bind(theme)),
					);
					continue;
				}
				const preview = truncateText(stripMarkdownForPreview(item.text), 180);
				if (preview) activityLines.push(theme.fg("toolOutput", preview));
			}

			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Recent activity:"), 0, 0));
			if (activityLines.length === 0) {
				container.addChild(
					new Text(theme.fg("dim", "Waiting for first model event..."), 0, 0),
				);
			} else {
				for (const line of activityLines) {
					container.addChild(new Text(line, 0, 0));
				}
			}

			const meta = formatResultMeta(result);
			if (meta) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", meta), 0, 0));
			}
			if (result.stderr.trim()) {
				container.addChild(new Text(theme.fg("muted", "stderr:"), 0, 0));
				container.addChild(
					new Text(
						theme.fg(
							"error",
							truncateText(collapseWhitespace(result.stderr), 220),
						),
						0,
						0,
					),
				);
			}

			box.addChild(container);
			return box;
		});
	};

	const runCommandSubagent = async (
		commandCtx: ExtensionCommandContext,
		agents: AgentConfig[],
		agentName: string,
		task: string,
		currentSessionModel?: string,
		workflowLabel?: string,
	): Promise<SingleResult> => {
		const label = workflowLabel
			? `${workflowLabel}: ${agentName}`
			: `Subagent ${agentName}`;
		commandCtx.ui.setWorkingMessage(
			`${label} running… queued prompts will wait for it to finish.`,
		);
		const result = await runSubagent(
			commandCtx.cwd,
			agents,
			agentName,
			task,
			DEFAULT_TIMEOUT_MS,
			currentSessionModel,
			(partial) => updateLiveSubagentUI(commandCtx, partial),
		);
		sendSubagentResult(result);
		return result;
	};

	pi.registerCommand("handoff", {
		description: "Show or clear the saved handoff buffer: /handoff [clear]",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				sendHandoffStatus("show", handoffBuffer);
				return;
			}
			if (command === "clear") {
				handoffBuffer = undefined;
				sendHandoffStatus("cleared");
				return;
			}
			ctx.ui.notify("Usage: /handoff [clear]", "warning");
		},
	});

	pi.registerCommand("subagent", {
		description:
			"Run one isolated subagent: /subagent <agent> [--no-handoff] <task>",
		getArgumentCompletions: makeAgentCompletions,
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /subagent <agent> [--no-handoff] <task>",
					"warning",
				);
				return;
			}

			const agents = discoverAgents(ctx.cwd).agents;
			const currentSessionModel = getCurrentSessionModel(ctx);
			const handoffTask =
				!parsed.noHandoff && handoffBuffer
					? buildTaskFromHandoff(parsed.agent, parsed.task, handoffBuffer)
					: undefined;
			const handoffForAgent = handoffTask ? handoffBuffer : undefined;
			const task = handoffTask ?? parsed.task;

			if (handoffForAgent) {
				sendHandoffStatus("used", handoffForAgent, parsed.agent);
			}

			try {
				const result = await runCommandSubagent(
					ctx,
					agents,
					parsed.agent,
					task,
					currentSessionModel,
				);
				saveHandoffFromResult(result);
			} finally {
				clearLiveSubagentUI(ctx);
			}
		},
	});

	pi.registerCommand("scout-and-plan", {
		description:
			"Run scout, then pass its findings to planner: /scout-and-plan <task>",
		handler: async (args, ctx) => {
			const task = parseTaskArgs(args);
			if (!task) {
				ctx.ui.notify("Usage: /scout-and-plan <task>", "warning");
				return;
			}

			const agents = discoverAgents(ctx.cwd).agents;
			const currentSessionModel = getCurrentSessionModel(ctx);

			try {
				const scoutResult = await runCommandSubagent(
					ctx,
					agents,
					"scout",
					task,
					currentSessionModel,
					"Workflow scout-and-plan",
				);
				saveHandoffFromResult(scoutResult, false);
				if (didSubagentFail(scoutResult)) {
					ctx.ui.notify(
						"/scout-and-plan stopped because scout failed.",
						"warning",
					);
					return;
				}

				const plannerResult = await runCommandSubagent(
					ctx,
					agents,
					"planner",
					buildPlannerTask(task, scoutResult.finalOutput),
					currentSessionModel,
					"Workflow scout-and-plan",
				);
				saveHandoffFromResult(plannerResult, false);
			} finally {
				clearLiveSubagentUI(ctx);
			}
		},
	});

	pi.registerCommand("implement", {
		description:
			"Run scout, planner, then worker with automatic handoff: /implement <task>",
		handler: async (args, ctx) => {
			const task = parseTaskArgs(args);
			if (!task) {
				ctx.ui.notify("Usage: /implement <task>", "warning");
				return;
			}

			const agents = discoverAgents(ctx.cwd).agents;
			const currentSessionModel = getCurrentSessionModel(ctx);

			try {
				const scoutResult = await runCommandSubagent(
					ctx,
					agents,
					"scout",
					task,
					currentSessionModel,
					"Workflow implement",
				);
				saveHandoffFromResult(scoutResult, false);
				if (didSubagentFail(scoutResult)) {
					ctx.ui.notify("/implement stopped because scout failed.", "warning");
					return;
				}

				const plannerResult = await runCommandSubagent(
					ctx,
					agents,
					"planner",
					buildPlannerTask(task, scoutResult.finalOutput),
					currentSessionModel,
					"Workflow implement",
				);
				saveHandoffFromResult(plannerResult, false);
				if (didSubagentFail(plannerResult)) {
					ctx.ui.notify(
						"/implement stopped because planner failed.",
						"warning",
					);
					return;
				}

				const workerResult = await runCommandSubagent(
					ctx,
					agents,
					"worker",
					buildWorkerTask(
						task,
						scoutResult.finalOutput,
						plannerResult.finalOutput,
					),
					currentSessionModel,
					"Workflow implement",
				);
				saveHandoffFromResult(workerResult, false);
			} finally {
				clearLiveSubagentUI(ctx);
			}
		},
	});

	pi.registerCommand("implement-and-review", {
		description:
			"Run worker, reviewer, then worker with automatic handoff: /implement-and-review <task>",
		handler: async (args, ctx) => {
			const task = parseTaskArgs(args);
			if (!task) {
				ctx.ui.notify("Usage: /implement-and-review <task>", "warning");
				return;
			}

			const agents = discoverAgents(ctx.cwd).agents;
			const currentSessionModel = getCurrentSessionModel(ctx);

			try {
				const workerResult = await runCommandSubagent(
					ctx,
					agents,
					"worker",
					task,
					currentSessionModel,
					"Workflow implement-and-review",
				);
				saveHandoffFromResult(workerResult, false);
				if (didSubagentFail(workerResult)) {
					ctx.ui.notify(
						"/implement-and-review stopped because worker failed.",
						"warning",
					);
					return;
				}

				const reviewerResult = await runCommandSubagent(
					ctx,
					agents,
					"reviewer",
					buildReviewerTask(task, workerResult.finalOutput),
					currentSessionModel,
					"Workflow implement-and-review",
				);
				saveHandoffFromResult(reviewerResult, false);
				if (didSubagentFail(reviewerResult)) {
					ctx.ui.notify(
						"/implement-and-review stopped because reviewer failed.",
						"warning",
					);
					return;
				}

				const revisedWorkerResult = await runCommandSubagent(
					ctx,
					agents,
					"worker",
					buildRevisionTask(
						task,
						workerResult.finalOutput,
						reviewerResult.finalOutput,
					),
					currentSessionModel,
					"Workflow implement-and-review",
				);
				saveHandoffFromResult(revisedWorkerResult, false);
			} finally {
				clearLiveSubagentUI(ctx);
			}
		},
	});
}
