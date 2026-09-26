import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptsDirectory, "../../../../..")
const verifyScript = join(scriptsDirectory, "verify-lsp.ts")
const sourceFile = join(repositoryRoot, "packages/agents-md-core/src/injector.ts")

test("verify-lsp performs a diagnostics roundtrip from the repository", () => {
	const result = spawnSync(process.execPath, [verifyScript, sourceFile, "--timeout=90000"], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env: process.env,
	})

	expect(result.status).toBe(0)
	expect(result.stdout).toContain("LSP roundtrip succeeded")
})
