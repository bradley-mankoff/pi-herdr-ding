/**
 * The ding: a pi session inside herdr plays a sound when its turn has settled, so the
 * Human knows it is his turn even with herdr's own pi sound off. These tests drive the
 * extension through pi's own events, as a person runs it: a real pi session in RPC or
 * print mode with a stand-in herdr and afplay first on PATH. The stand-ins write down
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
const pane = "w1:p1";

/** The system sound the build chose after herdr's own request sound proved silent with
 * pop-ups off. A known-good macOS file, not a value computed by the extension. */
const NEEDS_ATTENTION_SOUND = "/System/Library/Sounds/Ping.aiff";

type Machine = {
	root: string;
	home: string;
	repo: string;
	agentDir: string;
	afplayLog: string;
	herdrLog: string;
	/** Start pi outside herdr, with no HERDR_ENV and no pane id. */
	outsideHerdr: boolean;
	/** Ask the stand-in extension to hold the first turn's sound. */
	holdFirstTurn: boolean;
};

function makeMachine(options: Partial<Machine> = {}): Machine {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-ding-"));
	const home = path.join(root, "home");
	const repo = path.join(root, "repo");
	const bin = path.join(root, "bin");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(path.join(root, "pi-agent"), { recursive: true });
	const afplayLog = path.join(root, "afplay.log");
	const herdrLog = path.join(root, "herdr.log");
	fs.writeFileSync(
		path.join(bin, "afplay"),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "$AFPLAY_LOG"\nexit 0\n`,
	);
	fs.writeFileSync(
		path.join(bin, "herdr"),
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "$HERDR_LOG"\nexit 0\n`,
	);
	fs.chmodSync(path.join(bin, "afplay"), 0o755);
	fs.chmodSync(path.join(bin, "herdr"), 0o755);
	return {
		root,
		home,
		repo,
		agentDir: path.join(root, "pi-agent"),
		afplayLog,
		herdrLog,
		outsideHerdr: options.outsideHerdr ?? false,
		holdFirstTurn: options.holdFirstTurn ?? false,
	};
}

/** pi itself, found on the test's own PATH: the child's PATH starts with the stand-ins. */
function piOnPath(): string {
	const found = (process.env.PATH ?? "")
		.split(":")
		.map((entry) => path.join(entry, "pi"))
		.find((file) => fs.existsSync(file));
	if (!found) throw new Error("the tests need pi on PATH");
	return found;
}

function childEnv(machine: Machine): NodeJS.ProcessEnv {
	const bin = path.join(machine.root, "bin");
	const inherited = (process.env.PATH ?? "").split(":").filter(Boolean);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("HERDR_")) delete env[key];
	const child: NodeJS.ProcessEnv = {
		...env,
		HOME: machine.home,
		PATH: [bin, ...inherited].join(":"),
		PI_CODING_AGENT_DIR: machine.agentDir,
		PI_SKIP_VERSION_CHECK: "1",
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		AFPLAY_LOG: machine.afplayLog,
		HERDR_LOG: machine.herdrLog,
	};
	if (machine.holdFirstTurn) child.HOLD_FIRST_TURN = "1";
	if (!machine.outsideHerdr) {
		child.HERDR_ENV = "1";
		child.HERDR_PANE_ID = pane;
	}
	return child;
}

type Pi = {
	/** Sends one message and waits for its turn to settle. */
	turn: (message: string) => Promise<void>;
	stop: () => Promise<void>;
};

/** A pi session in RPC mode with the ding, the reply provider and the hold stand-in loaded
 * in that order, so the ding's turn-start reset runs before the hold is emitted. */
function startPi(machine: Machine): Pi {
	const extensions = [ding, testProvider, holdExtension];
	const child: ChildProcess = spawn(
		piOnPath(),
		[
			"--mode",
			"rpc",
			"-ne",
			"-ns",
			"-np",
			"-nc",
			"--no-mcp",
			...extensions.flatMap((extension) => ["-e", extension]),
			"--model",
			"reply-test/reply",
		],
		{ cwd: machine.repo, stdio: ["pipe", "pipe", "pipe"], env: childEnv(machine) },
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
			if (Date.now() - start > 20000) throw new Error(`pi's turn never settled\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
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

/** Runs one non-interactive pi session to its end: print mode, or JSON mode as a
 * sub-agent runs. */
function runOneShot(machine: Machine, mode: "print" | "json"): void {
	const args =
		mode === "print"
			? [
					"-ne",
					"-ns",
					"-np",
					"-nc",
					"--no-mcp",
					"-e",
					ding,
					"-e",
					testProvider,
					"--model",
					"reply-test/reply",
					"-p",
					"finish the turn",
				]
			: [
					"--mode",
					"json",
					"-ne",
					"-ns",
					"-np",
					"-nc",
					"--no-mcp",
					"-e",
					ding,
					"-e",
					testProvider,
					"--model",
					"reply-test/reply",
					"finish the turn",
				];
	const result = spawnSync(piOnPath(), args, {
		cwd: machine.repo,
		encoding: "utf8",
		timeout: 20000,
		env: childEnv(machine),
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
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Waits out the time a sound call would take to arrive, then returns what the stand-in
 * heard, for a test that expects silence. */
async function quiet(file: string): Promise<string[]> {
	await new Promise((resolve) => setTimeout(resolve, 1000));
	return lines(file);
}

test("a settled turn in a herdr pane plays the needs-attention sound", async () => {
	const machine = makeMachine();
	const pi = startPi(machine);
	try {
		await pi.turn("finish the turn");
		const calls = await waitForLines(machine.afplayLog, 1);

		assert.deepEqual(calls, [NEEDS_ATTENTION_SOUND]);
		assert.deepEqual(lines(machine.herdrLog), [], "no pop-up is shown");
	} finally {
		await pi.stop();
	}
});

test("a hold during a turn keeps that turn silent, and the next turn plays", async () => {
	const machine = makeMachine({ holdFirstTurn: true });
	const pi = startPi(machine);
	try {
		await pi.turn("start a Run that carries on by itself");
		const held = await quiet(machine.afplayLog);

		await pi.turn("take up the Run's report");
		const calls = await waitForLines(machine.afplayLog, 1);

		assert.deepEqual(held, [], "the held turn ends in silence");
		assert.deepEqual(calls, [NEEDS_ATTENTION_SOUND]);
	} finally {
		await pi.stop();
	}
});

test("outside herdr, a settled turn plays nothing", async () => {
	const machine = makeMachine({ outsideHerdr: true });
	const pi = startPi(machine);
	try {
		await pi.turn("finish the turn");
		const calls = await quiet(machine.afplayLog);

		assert.deepEqual(calls, []);
	} finally {
		await pi.stop();
	}
});

test("in print mode, where the session has no screen, a settled turn plays nothing", async () => {
	const machine = makeMachine();
	runOneShot(machine, "print");
	const calls = await quiet(machine.afplayLog);

	assert.deepEqual(calls, []);
});

test("in a sub-agent's JSON mode, a settled turn plays nothing", async () => {
	const machine = makeMachine();
	runOneShot(machine, "json");
	const calls = await quiet(machine.afplayLog);

	assert.deepEqual(calls, []);
});
