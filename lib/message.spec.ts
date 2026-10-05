import assert from "node:assert";
import { describe, it } from "mocha";
import { NLM_F_MULTI, NLM_F_REQUEST, NLMSG_DONE, NLMSG_ERROR } from "./constants.ts";
import {
  errnoOfMessage,
  formatMessage,
  isTerminatingMessage,
  nlmsgAlign,
  parseMessages
} from "./message.ts";
import { createNetlinkStructuresFor, hostStructures } from "./structures.ts";

const structures = hostStructures;

const header = {
  nlmsg_type: 18n,
  nlmsg_flags: NLM_F_REQUEST,
  nlmsg_seq: 7n,
  nlmsg_pid: 1234n,
};

const int32 = ({ value }: { value: number }) => {
  return new Uint8Array(new Int32Array([value]).buffer);
};

describe("message", () => {
  describe("nlmsgAlign", () => {
    it("should round up to multiples of 4", () => {
      assert.deepStrictEqual([0, 1, 3, 4, 5, 16, 17].map((length) => {
        return nlmsgAlign({ length });
      }), [0, 4, 4, 4, 8, 16, 20]);
    });
  });

  describe("formatMessage", () => {
    it("should prepend a header with the length of the message", () => {
      const payload = Uint8Array.from([1, 2, 3]);
      const data = formatMessage({ message: { header, payload }, structures });

      assert.strictEqual(data.length, 19);
      assert.deepStrictEqual(structures.nlmsghdr.parse({ data: data.subarray(0, 16) }), {
        nlmsg_len: 19n,
        ...header,
      });
      assert.deepStrictEqual([...data.subarray(16)], [1, 2, 3]);
    });
  });

  describe("parseMessages", () => {
    it("should return no messages for empty data", () => {
      assert.deepStrictEqual(parseMessages({ data: new Uint8Array(0), structures }), []);
    });

    it("should parse a formatted message", () => {
      const payload = Uint8Array.from([1, 2, 3, 4]);
      const data = formatMessage({ message: { header, payload }, structures });

      assert.deepStrictEqual(parseMessages({ data, structures }), [{ header, payload }]);
    });

    it("should parse multiple messages and skip the alignment padding", () => {
      const first = formatMessage({ message: { header, payload: Uint8Array.from([1, 2, 3]) }, structures });
      const second = formatMessage({
        message: { header: { ...header, nlmsg_flags: NLM_F_MULTI }, payload: Uint8Array.from([4]) },
        structures,
      });

      const data = new Uint8Array(nlmsgAlign({ length: first.length }) + second.length);
      data.set(first, 0);
      data.set(second, nlmsgAlign({ length: first.length }));

      const messages = parseMessages({ data, structures });

      assert.deepStrictEqual(messages.map((message) => {
        return [...message.payload];
      }), [[1, 2, 3], [4]]);
      assert.strictEqual(messages[1].header.nlmsg_flags, NLM_F_MULTI);
    });

    it("should copy payloads out of the receive buffer", () => {
      const data = formatMessage({ message: { header, payload: Uint8Array.from([1]) }, structures });
      const [message] = parseMessages({ data, structures });

      data.fill(0);

      assert.deepStrictEqual([...message.payload], [1]);
    });

    it("should throw if the data is too short for a header", () => {
      assert.throws(() => {
        parseMessages({ data: new Uint8Array(8), structures });
      }, /8 bytes left, but a header needs 16 bytes/);
    });

    it("should throw if nlmsg_len is shorter than the header", () => {
      const data = formatMessage({ message: { header, payload: new Uint8Array(0) }, structures });
      new DataView(data.buffer).setUint32(0, 8, true);

      assert.throws(() => {
        parseMessages({ data, structures });
      }, /nlmsg_len 8 is out of range \[16, 16\]/);
    });

    it("should throw if nlmsg_len exceeds the data", () => {
      const data = formatMessage({ message: { header, payload: new Uint8Array(4) }, structures });

      assert.throws(() => {
        parseMessages({ data: data.subarray(0, 18), structures });
      }, /nlmsg_len 20 is out of range \[16, 18\]/);
    });
  });

  describe("isTerminatingMessage", () => {
    it("should detect NLMSG_ERROR and NLMSG_DONE", () => {
      const results = [NLMSG_ERROR, NLMSG_DONE, 18n].map((nlmsg_type) => {
        return isTerminatingMessage({ message: { header: { ...header, nlmsg_type }, payload: new Uint8Array(0) } });
      });

      assert.deepStrictEqual(results, [true, true, false]);
    });
  });

  describe("errnoOfMessage", () => {
    it("should return undefined for other message types", () => {
      const message = { header, payload: new Uint8Array(0) };
      assert.strictEqual(errnoOfMessage({ message, structures }), undefined);
    });

    it("should return undefined for an acknowledgement", () => {
      const message = { header: { ...header, nlmsg_type: NLMSG_ERROR }, payload: new Uint8Array(20) };
      assert.strictEqual(errnoOfMessage({ message, structures }), undefined);
    });

    it("should return the positive errno of NLMSG_ERROR", () => {
      const payload = new Uint8Array(20);
      payload.set(int32({ value: -1 }), 0);

      const message = { header: { ...header, nlmsg_type: NLMSG_ERROR }, payload };
      assert.strictEqual(errnoOfMessage({ message, structures }), 1);
    });

    it("should return the errno of an NLMSG_DONE with error", () => {
      const message = { header: { ...header, nlmsg_type: NLMSG_DONE }, payload: int32({ value: -22 }) };
      assert.strictEqual(errnoOfMessage({ message, structures }), 22);
    });

    it("should read the error in the byte order of the ABI", () => {
      const bigEndianStructures = createNetlinkStructuresFor({
        abi: { endianness: "big", dataModel: "LP64", compiler: "gcc" },
      });

      const message = { header: { ...header, nlmsg_type: NLMSG_DONE }, payload: Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFE]) };
      assert.strictEqual(errnoOfMessage({ message, structures: bigEndianStructures }), 2);
    });

    it("should throw if the payload is too short for an error code", () => {
      const message = { header: { ...header, nlmsg_type: NLMSG_DONE }, payload: new Uint8Array(2) };

      assert.throws(() => {
        errnoOfMessage({ message, structures });
      }, /payload of type 3 too short for an error code/);
    });
  });
});
