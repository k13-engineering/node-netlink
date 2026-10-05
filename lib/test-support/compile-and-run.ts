import child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Compiles a C program with the host gcc and returns what it prints to stdout.
 */
const compileAndRun = async ({ sourceCode }: { sourceCode: string }) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "node-netlink-"));

  try {
    const sourceFile = path.join(directory, "program.c");
    const executable = path.join(directory, "program");

    await fs.promises.writeFile(sourceFile, sourceCode);

    child_process.execFileSync("gcc", ["-Wall", "-Werror", "-o", executable, sourceFile], { stdio: "pipe" });
    const output = child_process.execFileSync(executable, { encoding: "utf-8" });

    return { output };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

export {
  compileAndRun,
};
