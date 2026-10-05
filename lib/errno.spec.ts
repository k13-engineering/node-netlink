import assert from "node:assert";
import { describe, it } from "mocha";
import { createErrorFromErrno } from "./errno.ts";

describe("errno", () => {
  it("should name the errno and attach it", () => {
    const error = createErrorFromErrno({ operation: "request", errno: 1 });

    assert.strictEqual(error.message, "request failed with EPERM");
    assert.strictEqual(error.errno, 1);
  });

  it("should prefer canonical names over aliases", () => {
    assert.strictEqual(createErrorFromErrno({ operation: "request", errno: 11 }).message, "request failed with EAGAIN");
    assert.strictEqual(createErrorFromErrno({ operation: "request", errno: 95 }).message, "request failed with EOPNOTSUPP");
  });

  it("should handle unknown errnos", () => {
    const error = createErrorFromErrno({ operation: "request", errno: 9999 });

    assert.strictEqual(error.message, "request failed with unknown errno 9999");
    assert.strictEqual(error.errno, 9999);
  });
});
