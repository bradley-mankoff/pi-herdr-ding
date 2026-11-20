/**
 * The ding: a pi session inside herdr plays a sound when its turn has settled, so the
 * Human knows it is his turn even with herdr's own pi sound off. These tests drive the
 * extension through pi's own events, as a person runs it: a real pi session in RPC, print
 * or JSON mode with a stand-in herdr and afplay first on PATH. The stand-ins write down
 * every call, so a test reads what the session asked for without starting herdr or
 * playing a sound.
 *
 * The seam is the pi session with the extension loaded, not the extension's functions:
 * the tests care which command pi runs at the end of a turn, not how the file is shaped.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ding = path.join(repoRoot, "extensions", "ding.ts");
const testProvider = path.join(repoRoot, "tests", "fixtures", "reply-test-provider.ts");
const holdExtension = path.join(repoRoot, "tests", "fixtures", "hold-test-extension.ts");
const herdrPaneId = "w1:p1";

/** The system sound the build chose after herdr's own request sound proved silent with
 * pop-ups off. A known-good macOS file, not a value computed by the extension. */
const NEEDS_ATTENTION_SOUND = "/System/Library/Sounds/Ping.aiff";

/** pi's own switches for a test session: coding tools, skills, prompts and context files
 * off, and no MCP, so the stand-ins are the only place a call can land. */
const ISOLATED_PI_SWITCHES = ["-ne", "-ns", "-np", "-nc", "--no-mcp"];

/** The model the reply provider serves, so every turn ends with no network. */
const REPLY_MODEL = "reply-test/reply";

/** How many milliseconds a test waits before reading a log again. */
const POLL_MS = 20;

/** How long a turn or a one-shot session may take before the test calls it stuck. */
const PI_TIMEOUT_MS = 20000;

/** Long enough for a sound call to arrive if one were coming, so a test can read silence. */
const SOUND_WAIT_MS = 1000;

/** How a one-shot session is started: print mode, or JSON mode as a sub-agent runs. */
const PRINT_MODE_ARGS = ["-p", "finish the turn"];
const SUBAGENT_JSON_MODE_ARGS = ["--mode", "json", "finish the turn"];

/** What a test may ask of the sandbox it starts, beyond the defaults. */
type SandboxOptions = {
	/** Start pi outside herdr, with no HERDR_ENV and no pane id. */
	outsideHerdr?: boolean;
	/** Ask the stand-in extension to hold the first turn's sound. */
	holdFirstTurn?: boolean;
};

/** One test's private place to run a session: a temporary HOME, repo and stand-in bin, the
 * log files the stand-ins write their calls to, and the case the test asked for. */
type Sandbox = {
	root: string;
	home: string;
	repo: string;
	agentDir: string;
	afplayLog: string;
	herdrLog: string;
	outsideHerdr: boolean;
	holdFirstTurn: boolean;
};

/** Puts a stand-in command first on the child's PATH that writes its arguments to the log
 * named by `logVariable` in the child's environment. */
function writeStandIn(bin: string, name: string, logVariable: string): void {
	const file = path.join(bin, name);
	fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$${logVariable}"\nexit 0\n`);
	fs.chmodSync(file, 0o755);
}

function makeSandbox(options: SandboxOptions = {}): Sandbox {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-ding-"));
	const home = path.join(root, "home");
	const repo = path.join(root, "repo");
	const bin = path.join(root, "bin");
	const agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	const afplayLog = path.join(root, "afplay.log");
	const herdrLog = path.join(root, "herdr.log");
	writeStandIn(bin, "afplay", "DING_AFPLAY_LOG");
	writeStandIn(bin, "herdr", "DING_HERDR_LOG");
	return {
		root,
		home,
		repo,
		agentDir,
		afplayLog,
		herdrLog,
		outsideHerdr: options.outsideHerdr ?? false,
		holdFirstTurn: options.holdFirstTurn ?? false,
	};
}

/** The test process's PATH entries: the child's PATH starts with the stand-ins, then these. */
function pathEntries(): string[] {
	return (process.env.PATH ?? "").split(":").filter(Boolean);
}

/** pi itself, found on the test's own PATH, since the child's PATH starts with stand-ins. */
function piOnPath(): string {
	const found = pathEntries()
		.map((entry) => path.join(entry, "pi"))
		.find((file) => fs.existsSync(file));
	if (!found) throw new Error("the tests need pi on PATH");
	return found;
}

function childEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
	const child: NodeJS.ProcessEnv = {
		...process.env,
		HOME: sandbox.home,
		PATH: [path.join(sandbox.root, "bin"), ...pathEntries()].join(":"),
		PI_CODING_AGENT_DIR: sandbox.agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		DING_AFPLAY_LOG: sandbox.afplayLog,
		DING_HERDR_LOG: sandbox.herdrLog,
	};
	// The test process may itself run inside a herdr pane; a session starts inside herdr
	// only where the test asks for it.
	for (const key of Object.keys(child)) if (key.startsWith("HERDR_")) delete child[key];
	if (sandbox.holdFirstTurn) child.HOLD_FIRST_TURN = "1";
	if (!sandbox.outsideHerdr) {
		child.HERDR_ENV = "1";
		child.HERDR_PANE_ID = herdrPaneId;
	}
	return child;
}

/** The `-e` pairs that load the given extensions into a session. */
function extensionArgs(extensions: string[]): string[] {
	return extensions.flatMap((extension) => ["-e", extension]);
}

type PiSession = {
	/** Sends one message and waits for its turn to settle. */
	turn: (message: string) => Promise<void>;
	stop: () => Promise<void>;
};

/** A pi session in RPC mode with the ding, the reply provider and the hold stand-in loaded
 * in that order, so the ding has its hold listener before the stand-in emits. */
function startRpcSession(sandbox: Sandbox): PiSession {
	const extensions = [ding, testProvider, holdExtension];
	const child: ChildProcess = spawn(
		piOnPath(),
		[
			"--mode",
			"rpc",
			...ISOLATED_PI_SWITCHES,
			...extensionArgs(extensions),
			"--model",
			REPLY_MODEL,
		],
		{ cwd: sandbox.repo, stdio: ["pipe", "pipe", "pipe"], env: childEnv(sandbox) },
	);

	let buffer = "";
	let stderr = "";
	let settled = 0;
	let sent = 0;
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			if ((JSON.parse(line) as { type?: string }).type === "agent_settled") settled += 1;
		}
	});
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const waitForSettled = async (count: number): Promise<void> => {
		const start = Date.now();
		while (settled < count) {
			if (child.exitCode !== null) throw new Error(`pi exited before the turn ended\n${stderr}`);
			if (Date.now() - start > PI_TIMEOUT_MS) throw new Error(`pi's turn never settled\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	};

	const turn = async (message: string): Promise<void> => {
		const wanted = settled + 1;
		child.stdin!.write(`${JSON.stringify({ type: "prompt", message, id: `p${++sent}` })}\n`);
		await waitForSettled(wanted);
	};

	const stop = async (): Promise<void> => {
		child.stdin!.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 5000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	};

	return { turn, stop };
}

/** Runs one non-interactive session to its end with the ding loaded, and fails the test if
 * pi does not finish; `modeArgs` picks print mode or JSON mode. */
function runOneShot(sandbox: Sandbox, modeArgs: string[]): void {
	const args = [
		...ISOLATED_PI_SWITCHES,
		...extensionArgs([ding, testProvider]),
		"--model",
		REPLY_MODEL,
		...modeArgs,
	];
	const result = spawnSync(piOnPath(), args, {
		cwd: sandbox.repo,
		encoding: "utf8",
		timeout: PI_TIMEOUT_MS,
		env: childEnv(sandbox),
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function lines(file: string): string[] {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

async function waitForLines(file: string, count: number, timeoutMs = 15000): Promise<string[]> {
	const start = Date.now();
	for (;;) {
		const written = lines(file);
		if (written.length >= count) return written;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`${path.basename(file)} holds ${written.length} lines, not ${count}: ${written.join(" | ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
}

/** Waits out the time a sound call would take to arrive, then returns what the stand-in
 * heard, for a test that expects silence. */
async function callsInSilence(file: string): Promise<string[]> {
	await new Promise((resolve) => setTimeout(resolve, SOUND_WAIT_MS));
	return lines(file);
}

test("a settled turn in a herdr pane plays the needs-attention sound", async () => {
	const sandbox = makeSandbox();
	const session = startRpcSession(sandbox);
	try {
		await session.turn("finish the turn");
		const calls = await waitForLines(sandbox.afplayLog, 1);

		assert.deepEqual(calls, [NEEDS_ATTENTION_SOUND]);
		assert.deepEqual(lines(sandbox.herdrLog), [], "no pop-up is shown");
	} finally {
		await session.stop();
	}
});

test("a hold during a turn keeps that turn silent, and the next turn plays", async () => {
	const sandbox = makeSandbox({ holdFirstTurn: true });
	const session = startRpcSession(sandbox);
	try {
		await session.turn("start a Run that carries on by itself");
		const held = await callsInSilence(sandbox.afplayLog);

		await session.turn("take up the Run's report");
		const calls = await waitForLines(sandbox.afplayLog, 1);

		assert.deepEqual(held, [], "the held turn ends in silence");
		assert.deepEqual(calls, [NEEDS_ATTENTION_SOUND]);
	} finally {
		await session.stop();
	}
});

test("outside herdr, a settled turn plays nothing", async () => {
	const sandbox = makeSandbox({ outsideHerdr: true });
	const session = startRpcSession(sandbox);
	try {
		await session.turn("finish the turn");
		const calls = await callsInSilence(sandbox.afplayLog);

		assert.deepEqual(calls, []);
	} finally {
		await session.stop();
	}
});

test("in print mode, where the session has no screen, a settled turn plays nothing", async () => {
	const sandbox = makeSandbox();
	runOneShot(sandbox, PRINT_MODE_ARGS);
	const calls = await callsInSilence(sandbox.afplayLog);

	assert.deepEqual(calls, []);
});

test("in a sub-agent's JSON mode, a settled turn plays nothing", async () => {
	const sandbox = makeSandbox();
	runOneShot(sandbox, SUBAGENT_JSON_MODE_ARGS);
	const calls = await callsInSilence(sandbox.afplayLog);

	assert.deepEqual(calls, []);
});
