/**
 * Synthetic nested-agent metadata benchmark. No providers, kernels, sockets, or live sessions.
 * Run from packages/coding-agent: npx tsx test/rlm-scaling-bench.ts
 * Add --large-history for one 300-agent sample with roughly 1 MiB per transcript.
 * PRIME_BENCH_TMPDIR selects the scratch filesystem; fixtures are removed after each sample.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "../src/core/session-manager.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

const largeHistory = process.argv.includes("--large-history");

interface NodeFixture {
	id: string;
	file: string;
	parent?: string;
	depth: number;
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
	const start = performance.now();
	const value = await run();
	return { value, ms: Number((performance.now() - start).toFixed(3)) };
}

function makeFixtures(root: string, count: number): { sessionsDir: string; nodes: NodeFixture[] } {
	const sessionsDir = join(root, "sessions");
	const nodes: NodeFixture[] = [];
	for (let index = 0; index <= count; index++) {
		const parent = index > 0 ? nodes[Math.floor((index - 1) / 3)] : undefined;
		const depth = parent ? parent.depth + 1 : 0;
		const manager = SessionManager.create(root, index === 0 ? sessionsDir : join(root, "children", String(index)));
		manager.newSession(parent ? { parentSession: parent.file, rlmDepth: depth } : undefined);
		manager.appendSessionInfo(`agent-${index}`);
		for (let message = 0; message < (largeHistory ? 512 : 8); message++) {
			manager.appendMessage({ role: "user", content: `fixture-${message} ${"x".repeat(2048)}`, timestamp: message });
		}
		manager.flushNow();
		const file = manager.getSessionFile();
		assert(file);
		nodes.push({ id: `sub-${String(index).padStart(8, "0")}`, file, parent: parent?.file, depth });
	}
	return { sessionsDir, nodes };
}

async function sample(count: number) {
	const root = mkdtempSync(join(process.env.PRIME_BENCH_TMPDIR ?? tmpdir(), "prime-rlm-scaling-"));
	try {
		const { sessionsDir, nodes } = makeFixtures(root, count);
		const children = nodes.slice(1);
		const ledger = new RlmSpawnLedger(root, sessionsDir);
		const rssBefore = process.memoryUsage().rss;
		const admission = await timed(async () => {
			for (const node of children) {
				assert(node.parent);
				await ledger.appendSpawn({
					childId: node.id,
					parent: node.parent,
					child: node.file,
					depth: node.depth,
					name: node.id,
				});
			}
		});
		const firstFamily = await timed(() => ledger.family());
		assert.equal(firstFamily.value.length, count + 1);
		assert.equal(
			Math.max(...firstFamily.value.map((row) => row.rlmDepth ?? 0)),
			Math.max(...nodes.map((node) => node.depth)),
		);
		const warmFamilyMs: number[] = [];
		for (let iteration = 0; iteration < 3; iteration++) {
			const family = await timed(() => ledger.family());
			assert.equal(family.value.length, count + 1);
			warmFamilyMs.push(family.ms);
		}
		const concurrentEdges = await timed(() => Promise.all(Array.from({ length: count }, () => ledger.edges())));
		assert(concurrentEdges.value.every((edges) => edges.length === count));
		assert.notEqual(concurrentEdges.value[0][0], concurrentEdges.value[1][0]);
		const rename = await timed(async () => {
			for (const node of children)
				await ledger.appendRename({ childId: node.id, child: node.file, name: `renamed-${node.id}` });
		});
		const deleted = children.filter((_, index) => index % 5 === 0);
		const deletion = await timed(async () => {
			for (const node of deleted) await ledger.appendDelete({ childId: node.id, child: node.file, reason: "user" });
		});
		const reopen = await timed(() => new RlmSpawnLedger(root, sessionsDir).edges());
		assert.equal(reopen.value.length, count - deleted.length);
		assert(reopen.value.every((edge) => edge.name.startsWith("renamed-")));
		return {
			agents: count,
			maxDepth: Math.max(...nodes.map((node) => node.depth)),
			transcriptBytes: nodes.reduce((sum, node) => sum + statSync(node.file).size, 0),
			ledgerBytes: statSync(ledger.ledgerPath).size,
			durableAppends: children.length * 2 + deleted.length,
			admissionMs: admission.ms,
			firstFamilyMs: firstFamily.ms,
			warmFamilyMs,
			concurrentEdgeReaders: count,
			concurrentEdgesMs: concurrentEdges.ms,
			renameMs: rename.ms,
			deleteMs: deletion.ms,
			reopenReplayMs: reopen.ms,
			rssDeltaMiB: Number(((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(3)),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("RLM scaling benchmark must not make network/model requests");
};
try {
	for (const count of largeHistory ? [300] : [50, 150, 300]) console.log(JSON.stringify(await sample(count)));
} finally {
	globalThis.fetch = originalFetch;
}
