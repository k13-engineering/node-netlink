import assert from "node:assert";
import { describe, it } from "mocha";
import { AF_NETLINK, NETLINK_ROUTE } from "./constants.ts";
import { createPo6TransportFactory } from "./po6-transport.ts";
import { hostStructures } from "./structures.ts";
import { createFakePo6, createFakePoller } from "./test-support/fakes.ts";
import type { TNetlinkAddress } from "./netlink-socket.ts";

const structures = hostStructures;

const createTestSetup = () => {
  const fakePo6 = createFakePo6();
  const fakePoller = createFakePoller();

  let received: Uint8Array[] = [];
  let errors: Error[] = [];

  const transportFactory = createPo6TransportFactory({
    po6: fakePo6.po6,
    kernelAbi: fakePo6.kernelAbi,
    createPoller: fakePoller.createPoller,
    structures,
  });

  const open = ({ address = { nl_pid: 0n, nl_groups: 0n }, onData }: {
    address?: TNetlinkAddress,
    onData?: (args: { data: Uint8Array }) => void,
  } = {}) => {
    return transportFactory({
      family: NETLINK_ROUTE,
      address,
      onData: onData ?? (({ data }) => {
        received = [...received, data];
      }),
      onError: ({ error }) => {
        errors = [...errors, error];
      },
    });
  };

  return {
    fakePo6,
    fakePoller,
    open,
    received: () => {
      return received;
    },
    errors: () => {
      return errors;
    },
  };
};

describe("po6 transport", () => {
  describe("opening", () => {
    it("should create a non-blocking netlink socket for the family", () => {
      const { fakePo6, open } = createTestSetup();
      open();

      assert.deepStrictEqual(fakePo6.callsOf({ name: "socket" }), [{
        domain: AF_NETLINK,
        type: 2n | 0o4000n | 0o2000000n,
        protocol: NETLINK_ROUTE,
      }]);
    });

    it("should bind to the requested address", () => {
      const { fakePo6, open } = createTestSetup();
      open({ address: { nl_pid: 5n, nl_groups: 3n } });

      const [{ fd, sockaddr }] = fakePo6.callsOf({ name: "bind" });
      assert.strictEqual(fd, fakePo6.fd);
      assert.deepStrictEqual(structures.sockaddrNl.parse({ data: sockaddr as Uint8Array }), {
        nl_family: AF_NETLINK,
        nl_pad: 0n,
        nl_pid: 5n,
        nl_groups: 3n,
      });
    });

    it("should report the address assigned by the kernel", () => {
      const { fakePo6, open } = createTestSetup();
      fakePo6.assignPid({ pid: 1234 });

      const transport = open({ address: { nl_pid: 0n, nl_groups: 1n } });

      assert.deepStrictEqual(transport.address, { nl_pid: 1234n, nl_groups: 1n });
    });

    it("should wait for the socket to become readable", () => {
      const { fakePo6, fakePoller, open } = createTestSetup();
      open();

      assert.strictEqual(fakePoller.fdOfPoller(), fakePo6.fd);
      assert.strictEqual(fakePoller.isArmed(), true);
    });

    it("should throw if socket() fails", () => {
      const { fakePo6, open } = createTestSetup();
      fakePo6.failNext({ name: "socket", errno: fakePo6.kernelAbi.errnoCodes.EPROTONOSUPPORT });

      assert.throws(() => {
        open();
      }, /socket\(\) failed with EPROTONOSUPPORT/);
      assert.deepStrictEqual(fakePo6.callsOf({ name: "close" }), []);
    });

    (["bind", "getsockname"] as const).forEach((name) => {
      it(`should close the socket and throw if ${name}() fails`, () => {
        const { fakePo6, open } = createTestSetup();
        fakePo6.failNext({ name, errno: fakePo6.kernelAbi.errnoCodes.EADDRINUSE });

        assert.throws(() => {
          open();
        }, new RegExp(`${name}\\(\\) failed with EADDRINUSE`));
        assert.deepStrictEqual(fakePo6.callsOf({ name: "close" }), [{ fd: fakePo6.fd }]);
      });
    });

    it("should close the socket and throw if the poller cannot be created", () => {
      const { fakePo6, fakePoller, open } = createTestSetup();
      fakePoller.failCreation({ error: Error("no poller") });

      assert.throws(() => {
        open();
      }, /no poller/);
      assert.deepStrictEqual(fakePo6.callsOf({ name: "close" }), [{ fd: fakePo6.fd }]);
    });
  });

  describe("sending", () => {
    it("should send the datagram to the kernel", () => {
      const { fakePo6, open } = createTestSetup();
      const transport = open();

      const data = Uint8Array.from([1, 2, 3]);
      transport.send({ data });

      const [{ fd, data: sentData, msghdr }] = fakePo6.callsOf({ name: "sendmsg" });
      assert.strictEqual(fd, fakePo6.fd);
      assert.strictEqual(sentData, data);

      const { msg_name } = msghdr as { msg_name: Uint8Array };
      assert.deepStrictEqual(structures.sockaddrNl.parse({ data: msg_name }), {
        nl_family: AF_NETLINK,
        nl_pad: 0n,
        nl_pid: 0n,
        nl_groups: 0n,
      });
    });

    it("should throw if sendmsg() fails", () => {
      const { fakePo6, open } = createTestSetup();
      const transport = open();
      fakePo6.failNext({ name: "sendmsg", errno: fakePo6.kernelAbi.errnoCodes.ENOBUFS });

      assert.throws(() => {
        transport.send({ data: new Uint8Array(16) });
      }, /sendmsg\(\) failed with ENOBUFS/);
    });
  });

  describe("receiving", () => {
    it("should deliver all queued datagrams and wait for more", () => {
      const { fakePo6, fakePoller, open, received } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1, 2, 3]) });
      fakePo6.queueIncoming({ datagram: Uint8Array.from([4, 5]) });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received().map((data) => {
        return [...data];
      }), [[1, 2, 3], [4, 5]]);
      assert.strictEqual(fakePoller.isArmed(), true);
    });

    it("should peek the length of the datagram before receiving it", () => {
      const { fakePo6, fakePoller, open } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: new Uint8Array(70_000) });
      fakePoller.triggerReadable();

      const { MSG_DONTWAIT, MSG_PEEK, MSG_TRUNC } = fakePo6.kernelAbi.constants;
      const [peek, receive] = fakePo6.callsOf({ name: "recvmsg" });

      assert.strictEqual(peek.flags, MSG_PEEK | MSG_TRUNC | MSG_DONTWAIT);
      assert.strictEqual(receive.flags, MSG_DONTWAIT);
      assert.strictEqual((receive.data as Uint8Array).length, 70_000);
    });

    it("should deliver empty datagrams", () => {
      const { fakePo6, fakePoller, open, received } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: new Uint8Array(0) });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received().map((data) => {
        return data.length;
      }), [0]);
    });

    it("should report lost messages and keep receiving", () => {
      const { fakePo6, fakePoller, open, received, errors } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: { errno: fakePo6.kernelAbi.errnoCodes.ENOBUFS } });
      fakePo6.queueIncoming({ datagram: Uint8Array.from([1]) });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(errors().map((error) => {
        return error.message;
      }), ["recvmsg() failed with ENOBUFS: No buffer space available"]);
      assert.strictEqual(received().length, 1);
      assert.strictEqual(fakePoller.isArmed(), true);
    });

    it("should report other receive errors and stop receiving", () => {
      const { fakePo6, fakePoller, open, errors } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: { errno: fakePo6.kernelAbi.errnoCodes.EBADF } });
      fakePoller.triggerReadable();

      assert.strictEqual(errors().length, 1);
      assert.strictEqual(fakePoller.isArmed(), false);
    });

    it("should report errors of the second recvmsg()", () => {
      const { fakePo6, fakePoller, open, received, errors } = createTestSetup();
      open();

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1]) });
      fakePo6.failNext({ name: "recvmsg", errno: undefined });
      fakePo6.failNext({ name: "recvmsg", errno: fakePo6.kernelAbi.errnoCodes.EFAULT });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received(), []);
      assert.match(errors()[0].message, /recvmsg\(\) failed/);
    });

    it("should stop receiving if the socket is closed while delivering", () => {
      const { fakePo6, fakePoller, open } = createTestSetup();

      let deliveries = 0;
      const transport = open({
        onData: () => {
          deliveries += 1;
          transport.close();
        },
      });

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1]) });
      fakePo6.queueIncoming({ datagram: Uint8Array.from([2]) });
      fakePoller.triggerReadable();

      assert.strictEqual(deliveries, 1);
      assert.strictEqual(fakePoller.isArmed(), false);
    });

    it("should report poll errors", () => {
      const { fakePoller, open, errors } = createTestSetup();
      open();

      fakePoller.triggerError({ errorCode: -9 });

      assert.deepStrictEqual(errors().map((error) => {
        return error.message;
      }), ["polling netlink socket failed with libuv error -9"]);
    });
  });

  describe("closing", () => {
    it("should close the poller and the socket", () => {
      const { fakePo6, fakePoller, open } = createTestSetup();
      const transport = open();

      transport.close();

      assert.strictEqual(fakePoller.isClosed(), true);
      assert.deepStrictEqual(fakePo6.callsOf({ name: "close" }), [{ fd: fakePo6.fd }]);
    });

    it("should throw if close() fails", () => {
      const { fakePo6, open } = createTestSetup();
      const transport = open();
      fakePo6.failNext({ name: "close", errno: fakePo6.kernelAbi.errnoCodes.EBADF });

      assert.throws(() => {
        transport.close();
      }, /close\(\) failed with EBADF/);
    });
  });
});
