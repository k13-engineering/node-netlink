import assert from "node:assert";
import { describe, it } from "mocha";
import {
  NLM_F_ACK,
  NLM_F_DUMP,
  NLM_F_MULTI,
  NLM_F_REQUEST,
  NLMSG_DONE,
  NLMSG_ERROR
} from "./constants.ts";
import {
  formatMessage,
  nlmsgAlign,
  parseMessages,
  type TNetlinkHeader,
  type TNetlinkMessage
} from "./message.ts";
import { createNetlinkSocket, seqAfter, type TCreateNetlinkSocketArgs } from "./netlink-socket.ts";
import { hostStructures } from "./structures.ts";
import { createFakeTransport } from "./test-support/fakes.ts";

const structures = hostStructures;

const RTM_NEWLINK = 16n;
const RTM_GETLINK = 18n;

const int32 = ({ value }: { value: number }) => {
  return new Uint8Array(new Int32Array([value]).buffer);
};

const createTestSetup = ({ socketArgs = {}, nl_groups }: {
  socketArgs?: Partial<TCreateNetlinkSocketArgs>,
  nl_groups?: bigint,
} = {}) => {
  const fakeTransport = createFakeTransport({ nl_groups });

  let errors: Error[] = [];
  let unsolicited: TNetlinkMessage[] = [];

  const socket = createNetlinkSocket({
    transport: fakeTransport.transport,
    onMessage: ({ message }) => {
      unsolicited = [...unsolicited, message];
    },
    onError: ({ error }) => {
      errors = [...errors, error];
    },
    ...socketArgs,
  });

  const sentMessages = () => {
    return fakeTransport.sentDatagrams().flatMap((data) => {
      return parseMessages({ data, structures });
    });
  };

  const lastSentHeader = () => {
    return sentMessages().at(-1)?.header as TNetlinkHeader;
  };

  const respond = ({ messages }: { messages: { header: Partial<TNetlinkHeader>, payload: Uint8Array }[] }) => {
    const datagrams = messages.map(({ header, payload }) => {
      return formatMessage({
        message: {
          header: {
            nlmsg_type: RTM_NEWLINK,
            nlmsg_flags: 0n,
            nlmsg_pid: socket.nl_pid,
            ...header,
            nlmsg_seq: header.nlmsg_seq ?? lastSentHeader().nlmsg_seq,
          },
          payload,
        },
        structures,
      });
    });

    // like the kernel, pad every message to NLMSG_ALIGNTO
    const data = new Uint8Array(datagrams.reduce((sum, datagram) => {
      return sum + nlmsgAlign({ length: datagram.length });
    }, 0));

    datagrams.reduce((offset, datagram) => {
      data.set(datagram, offset);
      return offset + nlmsgAlign({ length: datagram.length });
    }, 0);

    fakeTransport.deliver({ data });
  };

  const ack = ({ error = 0 }: { error?: number } = {}) => {
    const payload = new Uint8Array(structures.nlmsgerr.size);
    payload.set(int32({ value: error }), 0);
    return { header: { nlmsg_type: NLMSG_ERROR }, payload };
  };

  return {
    fakeTransport,
    socket,
    sentMessages,
    lastSentHeader,
    respond,
    ack,
    errors: () => {
      return errors;
    },
    unsolicited: () => {
      return unsolicited;
    },
  };
};

describe("netlink socket", () => {
  describe("seqAfter", () => {
    it("should increment the sequence number", () => {
      assert.strictEqual(seqAfter({ seq: 1n }), 2n);
    });

    it("should wrap around to 1 after the largest 32 bit value", () => {
      assert.strictEqual(seqAfter({ seq: 0xFFFF_FFFFn }), 1n);
    });
  });

  describe("creation", () => {
    it("should listen on the transport", () => {
      const { fakeTransport, respond, unsolicited } = createTestSetup();

      respond({ messages: [{ header: { nlmsg_seq: 0n }, payload: new Uint8Array(0) }] });

      assert.strictEqual(unsolicited().length, 1);
      assert.strictEqual(fakeTransport.stopCount(), 0);
    });

    it("should expose the address of the transport", () => {
      const { socket } = createTestSetup({ nl_groups: 5n });

      assert.strictEqual(socket.nl_pid, 4711n);
      assert.strictEqual(socket.nl_groups, 5n);
    });
  });

  describe("send", () => {
    it("should send a request with the next sequence number", () => {
      const { socket, sentMessages } = createTestSetup();

      const first = socket.send({ header: { nlmsg_type: RTM_GETLINK }, payload: Uint8Array.from([1, 2]) });
      const second = socket.send({ header: { nlmsg_type: RTM_GETLINK }, payload: new Uint8Array(0) });

      assert.deepStrictEqual([first, second], [{ nlmsg_seq: 1n }, { nlmsg_seq: 2n }]);
      assert.deepStrictEqual(sentMessages()[0], {
        header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_REQUEST, nlmsg_seq: 1n, nlmsg_pid: 0n },
        payload: Uint8Array.from([1, 2]),
      });
    });

    it("should use the given header fields", () => {
      const { socket, lastSentHeader } = createTestSetup();

      const header = { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP, nlmsg_seq: 99n, nlmsg_pid: 7n };
      const { nlmsg_seq } = socket.send({ header, payload: new Uint8Array(0) });

      assert.strictEqual(nlmsg_seq, 99n);
      assert.deepStrictEqual(lastSentHeader(), header);
    });

    it("should throw once the socket is detached", () => {
      const { socket } = createTestSetup();
      socket.detach();

      assert.throws(() => {
        socket.send({ header: { nlmsg_type: RTM_GETLINK }, payload: new Uint8Array(0) });
      }, /netlink socket is detached/);
    });
  });

  describe("tryTalk", () => {
    it("should send a request with acknowledgement", async () => {
      const { socket, lastSentHeader, respond, ack } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      respond({ messages: [ack()] });
      await result;

      assert.strictEqual(lastSentHeader().nlmsg_flags, NLM_F_REQUEST | NLM_F_ACK);
    });

    it("should keep the requested flags", async () => {
      const { socket, lastSentHeader, respond } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP }, payload: new Uint8Array(4) });
      respond({ messages: [{ header: { nlmsg_type: NLMSG_DONE }, payload: int32({ value: 0 }) }] });
      await result;

      assert.strictEqual(lastSentHeader().nlmsg_flags, NLM_F_REQUEST | NLM_F_ACK | NLM_F_DUMP);
    });

    it("should resolve without messages on acknowledgement", async () => {
      const { socket, respond, ack } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      respond({ messages: [ack()] });

      assert.deepStrictEqual(await result, { errno: undefined, messages: [] });
    });

    it("should collect the responses of a dump", async () => {
      const { socket, respond } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP }, payload: new Uint8Array(4) });
      respond({
        messages: [
          { header: { nlmsg_flags: NLM_F_MULTI }, payload: Uint8Array.from([1]) },
          { header: { nlmsg_flags: NLM_F_MULTI }, payload: Uint8Array.from([2]) },
        ]
      });
      respond({
        messages: [
          { header: { nlmsg_flags: NLM_F_MULTI }, payload: Uint8Array.from([3]) },
          { header: { nlmsg_type: NLMSG_DONE, nlmsg_flags: NLM_F_MULTI }, payload: int32({ value: 0 }) },
        ]
      });

      const { errno, messages } = await result;

      assert.strictEqual(errno, undefined);
      assert.deepStrictEqual(messages.map((message) => {
        return [...message.payload];
      }), [[1], [2], [3]]);
    });

    it("should resolve with the errno reported by the kernel", async () => {
      const { socket, respond, ack } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      respond({ messages: [ack({ error: -1 })] });

      assert.deepStrictEqual(await result, { errno: 1, messages: [] });
    });

    it("should match responses by sequence number", async () => {
      const { socket, sentMessages, respond, ack } = createTestSetup();

      const first = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      const second = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });

      const [firstRequest, secondRequest] = sentMessages();
      respond({ messages: [{ ...ack({ error: -2 }), header: { nlmsg_type: NLMSG_ERROR, nlmsg_seq: secondRequest.header.nlmsg_seq } }] });
      respond({ messages: [{ ...ack(), header: { nlmsg_type: NLMSG_ERROR, nlmsg_seq: firstRequest.header.nlmsg_seq } }] });

      assert.deepStrictEqual(await first, { errno: undefined, messages: [] });
      assert.deepStrictEqual(await second, { errno: 2, messages: [] });
    });

    it("should reject if the terminating message is malformed", async () => {
      const { socket, respond } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_GETLINK }, payload: new Uint8Array(4) });
      respond({ messages: [{ header: { nlmsg_type: NLMSG_DONE }, payload: new Uint8Array(0) }] });

      await assert.rejects(result, /too short for an error code/);
    });

    it("should reject on timeout and treat late responses as unsolicited", async () => {
      const { socket, respond, ack, unsolicited } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4), timeoutMs: 5 });

      await assert.rejects(result, /netlink request timed out after 5 ms/);

      respond({ messages: [ack()] });
      assert.strictEqual(unsolicited().length, 1);
    });

    it("should reject if sending fails", async () => {
      const { socket, fakeTransport } = createTestSetup();
      fakeTransport.failSend({ error: Error("send failed") });

      await assert.rejects(socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) }), /send failed/);
    });

    it("should reject once the socket is detached", async () => {
      const { socket } = createTestSetup();
      socket.detach();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      await assert.rejects(result, /netlink socket is detached/);
    });
  });

  describe("talk", () => {
    it("should resolve with the responses", async () => {
      const { socket, respond, ack } = createTestSetup();

      const result = socket.talk({ header: { nlmsg_type: RTM_GETLINK }, payload: new Uint8Array(4) });
      respond({ messages: [{ header: {}, payload: Uint8Array.from([1]) }, ack()] });

      const messages = await result;
      assert.deepStrictEqual(messages.map((message) => {
        return [...message.payload];
      }), [[1]]);
    });

    it("should reject with the errno reported by the kernel", async () => {
      const { socket, respond, ack } = createTestSetup();

      const result = socket.talk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      respond({ messages: [ack({ error: -1 })] });

      await assert.rejects(result, /netlink request of type 16 failed with EPERM/);
    });
  });

  describe("unsolicited messages", () => {
    it("should deliver messages that do not belong to a request", () => {
      const { respond, unsolicited } = createTestSetup();

      respond({ messages: [{ header: { nlmsg_seq: 0n }, payload: Uint8Array.from([1]) }] });

      assert.deepStrictEqual(unsolicited().map((message) => {
        return [...message.payload];
      }), [[1]]);
    });

    it("should not treat requests of other sockets as responses", async () => {
      const { socket, respond, ack, unsolicited } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      respond({ messages: [{ header: { nlmsg_flags: NLM_F_REQUEST }, payload: Uint8Array.from([1]) }, ack()] });

      assert.deepStrictEqual(await result, { errno: undefined, messages: [] });
      assert.strictEqual(unsolicited().length, 1);
    });

    it("should stop delivering once a handler detached the socket", () => {
      let delivered = 0;
      const { socket, respond } = createTestSetup({
        socketArgs: {
          onMessage: () => {
            delivered += 1;
            socket.detach();
          },
        },
      });

      respond({
        messages: [
          { header: { nlmsg_seq: 0n }, payload: Uint8Array.from([1]) },
          { header: { nlmsg_seq: 0n }, payload: Uint8Array.from([2]) },
        ]
      });

      assert.strictEqual(delivered, 1);
    });

    it("should drop unsolicited messages without onMessage handler", () => {
      const { respond, errors } = createTestSetup({ socketArgs: { onMessage: undefined } });

      respond({ messages: [{ header: { nlmsg_seq: 0n }, payload: Uint8Array.from([1]) }] });

      assert.deepStrictEqual(errors(), []);
    });
  });

  describe("errors", () => {
    it("should pass malformed datagrams to onError", () => {
      const { fakeTransport, errors } = createTestSetup();

      fakeTransport.deliver({ data: new Uint8Array(3) });

      assert.strictEqual(errors().length, 1);
      assert.match(errors()[0].message, /malformed netlink message/);
    });

    it("should pass transport errors to onError", () => {
      const { fakeTransport, errors } = createTestSetup();

      const error = Error("receive failed");
      fakeTransport.raise({ error });

      assert.deepStrictEqual(errors(), [error]);
    });

    it("should throw errors asynchronously without onError handler", async () => {
      const { fakeTransport } = createTestSetup({ socketArgs: { onError: undefined } });

      const listeners = process.listeners("uncaughtException");
      process.removeAllListeners("uncaughtException");

      try {
        const thrown = await new Promise<Error>((resolve) => {
          process.once("uncaughtException", resolve);
          fakeTransport.deliver({ data: new Uint8Array(3) });
        });

        assert.match(thrown.message, /malformed netlink message/);
      } finally {
        listeners.forEach((listener) => {
          process.on("uncaughtException", listener);
        });
      }
    });
  });

  describe("detach", () => {
    it("should stop listening on the transport once", () => {
      const { socket, fakeTransport } = createTestSetup();

      socket.detach();
      socket.detach();

      assert.strictEqual(fakeTransport.stopCount(), 1);
    });

    it("should reject pending requests", async () => {
      const { socket } = createTestSetup();

      const result = socket.tryTalk({ header: { nlmsg_type: RTM_NEWLINK }, payload: new Uint8Array(4) });
      socket.detach();

      await assert.rejects(result, /netlink socket was detached while waiting for a response/);
    });
  });
});
