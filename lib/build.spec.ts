import assert from "node:assert";
import nodeChildProcess from "node:child_process";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import { after, describe, it } from "mocha";

const projectRoot = nodePath.resolve(import.meta.dirname, "..");

const binary = ({ name }: { name: string }) => {
  return nodePath.join(projectRoot, "node_modules", ".bin", name);
};

const buildPackage = ({ outDirectory }: { outDirectory: string }) => {
  nodeChildProcess.execFileSync(binary({ name: "deno-node-build" }), [
    "--root", projectRoot,
    "--out", `${outDirectory}/`,
    "--entry", "lib/index.ts",
  ], { stdio: "pipe" });
};

const emitDeclarationsWithTypeScript = ({ outDirectory }: { outDirectory: string }) => {
  nodeChildProcess.execFileSync(binary({ name: "tsc" }), [
    "--project", nodePath.join(projectRoot, "tsconfig.json"),
    "--declaration",
    "--emitDeclarationOnly",
    "--noEmit", "false",
    "--outDir", outDirectory,
  ], { stdio: "pipe" });
};

// The published package is the output of deno-node-build, which generates the declaration files per
// file. Types it cannot infer without the other files end up as any, unknown or even narrower types
// than the real ones, which silently breaks the type checks of users. The declarations must therefore
// be the ones the TypeScript compiler generates for the whole project.
describe("built package", () => {
  const outDirectory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "netlink-build-"));

  after(() => {
    nodeFs.rmSync(outDirectory, { recursive: true, force: true });
  });

  it("should declare the same types as the TypeScript compiler", () => {
    const packageDirectory = nodePath.join(outDirectory, "package");
    const typescriptDirectory = nodePath.join(outDirectory, "typescript");

    buildPackage({ outDirectory: packageDirectory });
    emitDeclarationsWithTypeScript({ outDirectory: typescriptDirectory });

    const declarationFiles = nodeFs.readdirSync(nodePath.join(packageDirectory, "lib")).filter((file) => {
      return file.endsWith(".d.ts");
    });

    const differingFiles = declarationFiles.filter((file) => {
      // deno-node-build rewrites the imports to the transpiled .js files
      const published = nodeFs.readFileSync(nodePath.join(packageDirectory, "lib", file), "utf8").replaceAll(".js\"", ".ts\"");
      const expected = nodeFs.readFileSync(nodePath.join(typescriptDirectory, "lib", file), "utf8");

      return published !== expected;
    });

    assert.ok(declarationFiles.length > 1);
    assert.deepStrictEqual(differingFiles, []);
  }).timeout(120_000);
});
