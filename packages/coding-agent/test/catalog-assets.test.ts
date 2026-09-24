import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	copySourceCatalogAssets,
	generateBundledCatalogAssets,
	MAX_REMOTE_CATALOG_BYTES,
} from "../scripts/catalog-assets.mjs";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.GITHUB_TOKEN;
	delete process.env.PRIME_CATALOG_REPO_TOKEN;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "catalog-assets-"));
	tempDirs.push(dir);
	return dir;
}

function modelCatalog(): string {
	return `${JSON.stringify({
		schemaVersion: 1,
		models: [
			{
				id: "fixture",
				name: "Fixture",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
	})}
`;
}

function mcpCatalog(): string {
	return `${JSON.stringify({ version: 2, counts: { entries: 0 }, entries: [] })}
`;
}

describe("catalog asset generation", () => {
	it("does not send GitHub tokens to custom catalog URLs unless explicitly allowed", async () => {
		process.env.GITHUB_TOKEN = "secret-token";
		const seen: Array<{ url: string; authorization?: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				seen.push({ url, authorization: headers.get("authorization") ?? undefined });
				return new Response(url.includes("models") ? modelCatalog() : mcpCatalog());
			}),
		);

		await generateBundledCatalogAssets({
			outDir: tempDir(),
			modelsUrl: "https://example.test/models.json",
			mcpServicesUrl: "https://example.test/plugins.json",
			allowSmallFixture: true,
		});

		expect(seen.map((entry) => entry.authorization)).toEqual([undefined, undefined]);

		seen.length = 0;
		await generateBundledCatalogAssets({
			outDir: tempDir(),
			modelsUrl: "https://example.test/models.json",
			mcpServicesUrl: "https://example.test/plugins.json",
			allowSmallFixture: true,
			allowTokenForUrl: true,
		});

		expect(seen.map((entry) => entry.authorization)).toEqual(["Bearer secret-token", "Bearer secret-token"]);
	});

	it("stops reading chunked remote catalogs after the byte cap", async () => {
		let cancelled = false;
		const oversizedResponse = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(new Uint8Array(MAX_REMOTE_CATALOG_BYTES + 1));
					},
					cancel() {
						cancelled = true;
					},
				}),
			);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes("models") ? oversizedResponse() : new Response(mcpCatalog()),
			),
		);

		await expect(
			generateBundledCatalogAssets({
				outDir: tempDir(),
				modelsUrl: "https://example.test/models.json",
				mcpServicesUrl: "https://example.test/plugins.json",
				allowSmallFixture: true,
			}),
		).rejects.toThrow(/model catalog is too large/);
		expect(cancelled).toBe(true);
	});

	it("sends GitHub tokens to the trusted contents API fallback", async () => {
		process.env.GITHUB_TOKEN = "secret-token";
		const seen: Array<{ url: string; authorization?: string }> = [];
		const rawModelUrl =
			"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/models/catalog.v1.json";
		const rawMcpUrl =
			"https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/main/plugins/catalog.v2.json";
		const apiModelUrl =
			"https://api.github.com/repos/PrimeIntellect-ai/prime-agent-catalog/contents/models/catalog.v1.json?ref=main";
		const apiMcpUrl =
			"https://api.github.com/repos/PrimeIntellect-ai/prime-agent-catalog/contents/plugins/catalog.v2.json?ref=main";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				seen.push({ url, authorization: headers.get("authorization") ?? undefined });
				if (url === rawModelUrl || url === rawMcpUrl) return new Response("not found", { status: 404 });
				if (url === apiModelUrl) return new Response(modelCatalog());
				if (url === apiMcpUrl) return new Response(mcpCatalog());
				return new Response("unexpected url", { status: 500 });
			}),
		);

		await generateBundledCatalogAssets({ outDir: tempDir(), allowSmallFixture: true });

		expect(seen).toHaveLength(4);
		expect(seen.every((entry) => entry.authorization === "Bearer secret-token")).toBe(true);
		expect(seen.filter((entry) => entry.url === rawModelUrl || entry.url === rawMcpUrl)).toHaveLength(2);
		expect(seen.filter((entry) => entry.url === apiModelUrl || entry.url === apiMcpUrl)).toHaveLength(2);
	});

	it("copies generated flat source assets into dist", async () => {
		const outDir = tempDir();
		const catalogDir = join(process.cwd(), "catalog");
		expect(existsSync(join(catalogDir, "models.bundled.json"))).toBe(true);
		expect(existsSync(join(catalogDir, "mcp-services.bundled.json"))).toBe(true);

		await copySourceCatalogAssets({ outDir, allowSmallFixture: true });

		expect(readFileSync(join(outDir, "models.bundled.json"), "utf8")).toBe(
			readFileSync(join(catalogDir, "models.bundled.json"), "utf8"),
		);
		expect(readFileSync(join(outDir, "mcp-services.bundled.json"), "utf8")).toBe(
			readFileSync(join(catalogDir, "mcp-services.bundled.json"), "utf8"),
		);
	});

	it("preserves catalogs when copying binary assets into the default dist directory", () => {
		const root = realpathSync(tempDir());
		const packageDir = join(root, "packages/coding-agent");
		const scriptsDir = join(packageDir, "scripts");
		mkdirSync(scriptsDir, { recursive: true });
		for (const script of ["copy-binary-assets.mjs", "catalog-assets.mjs"]) {
			cpSync(join(process.cwd(), "scripts", script), join(scriptsDir, script));
		}
		for (const path of [
			"install.sh",
			"LICENSE",
			"prime-agent-runtime/pyproject.toml",
			"node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
			...[
				"package.json",
				"README.md",
				"CHANGELOG.md",
				"skills/fixture.md",
				"src/modes/interactive/theme/prime.json",
				"src/modes/interactive/assets/fixture.txt",
				"src/core/export-html/template.html",
				"docs/fixture.md",
				"examples/fixture.md",
			].map((path) => `packages/coding-agent/${path}`),
		]) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), "fixture");
		}
		const distDir = join(packageDir, "dist");
		mkdirSync(distDir);
		writeFileSync(join(distDir, "models.bundled.json"), modelCatalog());
		writeFileSync(join(distDir, "mcp-services.bundled.json"), mcpCatalog());

		execFileSync(process.execPath, [join(scriptsDir, "copy-binary-assets.mjs")]);

		expect(readFileSync(join(distDir, "models.bundled.json"), "utf8")).toBe(modelCatalog());
		expect(readFileSync(join(distDir, "mcp-services.bundled.json"), "utf8")).toBe(mcpCatalog());
		expect(readFileSync(join(distDir, "README.md"), "utf8")).toBe("fixture");
	});
});
