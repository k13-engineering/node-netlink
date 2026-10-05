import assert from "node:assert";
import { describe, it } from "mocha";
import { compileAndCompare } from "ya-struct";
import { hostAbi } from "po6";
import {
  createNetlinkStructuresFor,
  hostStructures,
  nlmsgerrDefinition,
  nlmsghdrDefinition,
  sockaddrNlDefinition
} from "./structures.ts";
import { compileAndRun } from "./test-support/compile-and-run.ts";

const globalCode = `
#include <sys/socket.h>
#include <linux/netlink.h>
`;

const structs = [
  { cStructName: "sockaddr_nl", structDefinition: sockaddrNlDefinition },
  { cStructName: "nlmsghdr", structDefinition: nlmsghdrDefinition },
  { cStructName: "nlmsgerr", structDefinition: nlmsgerrDefinition },
];

describe("structures", () => {
  describe("layout", () => {
    structs.forEach(({ cStructName, structDefinition }) => {
      it(`should match struct ${cStructName} of the C headers`, async () => {
        const { layoutErrors } = await compileAndCompare({
          structDefinition,
          abi: hostAbi,
          globalCode,
          cStructName,
          compileAndRun,
        });

        assert.deepStrictEqual(layoutErrors, []);
      });
    });
  });

  describe("sizes", () => {
    it("should have the sizes defined by the kernel ABI", () => {
      assert.strictEqual(hostStructures.sockaddrNl.size, 12);
      assert.strictEqual(hostStructures.nlmsghdr.size, 16);
      assert.strictEqual(hostStructures.nlmsgerr.size, 20);
    });
  });

  describe("byte order", () => {
    it("should format big endian structures for big endian ABIs", () => {
      const structures = createNetlinkStructuresFor({
        abi: { endianness: "big", dataModel: "ILP32", compiler: "gcc" },
      });

      const data = structures.sockaddrNl.format({
        value: { nl_family: 16n, nl_pad: 0n, nl_pid: 0x01020304n, nl_groups: 0n },
      });

      assert.deepStrictEqual([...data.subarray(0, 8)], [0, 16, 0, 0, 1, 2, 3, 4]);
    });
  });
});
