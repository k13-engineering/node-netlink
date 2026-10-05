import assert from "node:assert";
import { describe, it } from "mocha";
import * as constants from "./constants.ts";
import { compileAndRun } from "./test-support/compile-and-run.ts";

// constants introduced by recent kernels are missing in older headers, guard them
const printStatementFor = ({ name }: { name: string }) => {
  return `#ifdef ${name}
  printf("${name} %lld\\n", (long long) ${name});
#endif`;
};

const valuesFromCHeaders = async ({ names }: { names: string[] }) => {
  const sourceCode = `#include <stdio.h>
#include <sys/socket.h>
#include <linux/netlink.h>

int main(void) {
${names.map((name) => {
    return printStatementFor({ name });
  }).join("\n")}
  return 0;
}
`;

  const { output } = await compileAndRun({ sourceCode });

  return output.trim().split("\n").map((line) => {
    const [name, value] = line.split(" ");
    return { name, value: BigInt(value) };
  });
};

describe("constants", () => {
  it("should match the values of the C headers", async () => {
    const names = Object.keys(constants);
    const valuesFromC = await valuesFromCHeaders({ names });

    // all constants except the newest ones must be known to the headers of any supported system
    assert.ok(valuesFromC.length >= names.length - 2, `only ${valuesFromC.length} of ${names.length} constants found in C headers`);

    valuesFromC.forEach(({ name, value }) => {
      assert.strictEqual(constants[name as keyof typeof constants], value, `${name} differs from the C headers`);
    });
  });
});
