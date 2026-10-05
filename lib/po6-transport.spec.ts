import assert from "node:assert";
import { describe, it } from "mocha";
import { AF_NETLINK } from "./constants.ts";
import { createPo6NetlinkTransport } from "./po6-transport.ts";
import { formatNetlinkAddress, hostStructures } from "./structures.ts";
import { createFakePo6, createFakePoller } from "./test-support/fakes.ts";

const structures = hostStructures;

const createTestSetup = () => {
  const fakePo6 = createFakePo6();
  const fakePoller = createFakePoller();

  let received: Uint8Array[] = [];
  let errors: Error[] = [];

  const createTransport = () => {
    return createPo6NetlinkTransport({
      fd: fakePo6.fd,
      po6: fakePo6.po6,
      kernelAbi: fakePo6.kernelAbi,
      createPoller: fakePoller.createPoller,
    });
  };

  const listen = ({ onData }: { onData?: (args: { data: Uint8Array }) => void } = {}) => {
    const transport = createTransport();

    const listener = transport.listen({
      onData: onData ?? (({ data }) => {
        received = [...received, data];
      }),
      onError: ({ error }) => {
        errors = [...errors, error];
      },
    });

    return { transport, listener };
  };

  return {
    fakePo6,
    fakePoller,
    createTransport,
    listen,
    received: () => {
      return received;
    },
    errors: () => {
      return errors;
    },
  };
};

describe("po6 transport", () => {
  describe("creation", () => {
    it("should report the address the socket is bound to", () => {
      const { fakePo6, createTransport } = createTestSetup();
      fakePo6.setSockname({ sockaddr: formatNetlinkAddress({ address: { nl_pid: 1234n, nl_groups: 5n } }) });

      const transport = createTransport();

      assert.deepStrictEqual(transport.address, { nl_pid: 1234n, nl_groups: 5n });
      assert.deepStrictEqual(fakePo6.callsOf({ name: "getsockname" }), [{ fd: fakePo6.fd }]);
    });

    it("should not wait for data before listen() is called", () => {
      const { fakePoller, createTransport } = createTestSetup();
      createTransport();

      assert.strictEqual(fakePoller.fdOfPoller(), undefined);
    });

    it("should throw if getsockname() fails", () => {
      const { fakePo6, createTransport } = createTestSetup();
      fakePo6.failNext({ name: "getsockname", errno: fakePo6.kernelAbi.errnoCodes.EBADF });

      assert.throws(() => {
        createTransport();
      }, /getsockname\(\) failed with EBADF/);
    });

    it("should throw if the file descriptor is not a netlink socket", () => {
      const { fakePo6, createTransport } = createTestSetup();

      // struct sockaddr_in of AF_INET
      const sockaddr = new Uint8Array(16);
      sockaddr.set([2, 0], 0);
      fakePo6.setSockname({ sockaddr });

      assert.throws(() => {
        createTransport();
      }, /file descriptor 42 is not a netlink socket, its address family is 2/);
    });
  });

  describe("sending", () => {
    it("should send the datagram to the kernel", () => {
      const { fakePo6, createTransport } = createTestSetup();
      const transport = createTransport();

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
      const { fakePo6, createTransport } = createTestSetup();
      const transport = createTransport();
      fakePo6.failNext({ name: "sendmsg", errno: fakePo6.kernelAbi.errnoCodes.ENOBUFS });

      assert.throws(() => {
        transport.send({ data: new Uint8Array(16) });
      }, /sendmsg\(\) failed with ENOBUFS/);
    });
  });

  describe("listening", () => {
    it("should wait for the socket to become readable", () => {
      const { fakePo6, fakePoller, listen } = createTestSetup();
      listen();

      assert.strictEqual(fakePoller.fdOfPoller(), fakePo6.fd);
      assert.strictEqual(fakePoller.isArmed(), true);
    });

    it("should deliver all queued datagrams and wait for more", () => {
      const { fakePo6, fakePoller, listen, received } = createTestSetup();
      listen();

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1, 2, 3]) });
      fakePo6.queueIncoming({ datagram: Uint8Array.from([4, 5]) });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received().map((data) => {
        return [...data];
      }), [[1, 2, 3], [4, 5]]);
      assert.strictEqual(fakePoller.isArmed(), true);
    });

    it("should peek the length of the datagram before receiving it", () => {
      const { fakePo6, fakePoller, listen } = createTestSetup();
      listen();

      fakePo6.queueIncoming({ datagram: new Uint8Array(70_000) });
      fakePoller.triggerReadable();

      const { MSG_DONTWAIT, MSG_PEEK, MSG_TRUNC } = fakePo6.kernelAbi.constants;
      const [peek, receive] = fakePo6.callsOf({ name: "recvmsg" });

      assert.strictEqual(peek.flags, MSG_PEEK | MSG_TRUNC | MSG_DONTWAIT);
      assert.strictEqual(receive.flags, MSG_DONTWAIT);
      assert.strictEqual((receive.data as Uint8Array).length, 70_000);
    });

    it("should deliver empty datagrams", () => {
      const { fakePo6, fakePoller, listen, received } = createTestSetup();
      listen();

      fakePo6.queueIncoming({ datagram: new Uint8Array(0) });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received().map((data) => {
        return data.length;
      }), [0]);
    });

    it("should report lost messages and keep receiving", () => {
      const { fakePo6, fakePoller, listen, received, errors } = createTestSetup();
      listen();

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
      const { fakePo6, fakePoller, listen, errors } = createTestSetup();
      listen();

      fakePo6.queueIncoming({ datagram: { errno: fakePo6.kernelAbi.errnoCodes.EBADF } });
      fakePoller.triggerReadable();

      assert.strictEqual(errors().length, 1);
      assert.strictEqual(fakePoller.isArmed(), false);
    });

    it("should report errors of the second recvmsg()", () => {
      const { fakePo6, fakePoller, listen, received, errors } = createTestSetup();
      listen();

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1]) });
      fakePo6.failNext({ name: "recvmsg", errno: undefined });
      fakePo6.failNext({ name: "recvmsg", errno: fakePo6.kernelAbi.errnoCodes.EFAULT });
      fakePoller.triggerReadable();

      assert.deepStrictEqual(received(), []);
      assert.match(errors()[0].message, /recvmsg\(\) failed with EFAULT/);
    });

    it("should report poll errors", () => {
      const { fakePoller, listen, errors } = createTestSetup();
      listen();

      fakePoller.triggerError({ errorCode: -9 });

      assert.deepStrictEqual(errors().map((error) => {
        return error.message;
      }), ["polling netlink socket failed with libuv error -9"]);
    });
  });

  describe("stopping", () => {
    it("should close the poller but leave the socket open", () => {
      const { fakePoller, listen } = createTestSetup();
      const { listener } = listen();

      listener.stop();
      listener.stop();

      assert.strictEqual(fakePoller.isClosed(), true);
    });

    it("should stop receiving if stopped while delivering", () => {
      const { fakePo6, fakePoller, createTransport } = createTestSetup();

      let deliveries = 0;
      const listener = createTransport().listen({
        onData: () => {
          deliveries += 1;
          listener.stop();
        },
        onError: () => {
          throw Error("unexpected error");
        },
      });

      fakePo6.queueIncoming({ datagram: Uint8Array.from([1]) });
      fakePo6.queueIncoming({ datagram: Uint8Array.from([2]) });
      fakePoller.triggerReadable();

      assert.strictEqual(deliveries, 1);
      assert.strictEqual(fakePoller.isArmed(), false);
    });
  });
});
