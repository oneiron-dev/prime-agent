import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// Builds the package once into a temporary directory; CLI tests run that build, as installed.
		globalSetup: ["./test/global-setup.ts"],
		// The suites spawn real processes (Python runners, git, Node children); bound the parallel fan-out.
		maxWorkers: 4,
	},
});
