import assert from "node:assert";
import { describe, it } from "mocha";
import {
  NETLINK_ROUTE,
  NLM_F_DUMP,
  openNetlinkSocket,
  type TNetlinkSocket
} from "./index.ts";
import { reportUnhandledError } from "./system.ts";

// <linux/rtnetlink.h>
const RTM_NEWLINK = 16n;
const RTM_GETLINK = 18n;
const RTMGRP_LINK = 1n;

// <linux/if_link.h>, struct ifinfomsg: family, pad, type, index, flags, change
const ifinfomsg = ({ index }: { index: number }) => {
  const payload = new Uint8Array(16);
  new DataView(payload.buffer).setInt32(4, index, true);
  return payload;
};

const indexOfLink = ({ payload }: { payload: Uint8Array }) => {
  return new DataView(payload.buffer, payload.byteOffset).getInt32(4, true);
};

// errno of the host, used to check that the kernel's error reaches the caller
const ENODEV = 19;

const withSocket = async ({ nl_groups, callback }: {
  nl_groups?: bigint,
  callback: (args: { socket: TNetlinkSocket }) => Promise<void>,
}) => {
  const socket = openNetlinkSocket({ family: NETLINK_ROUTE, nl_groups });

  try {
    await callback({ socket });
  } finally {
    socket.close();
  }
};

describe("node-netlink on the host kernel", () => {
  it("should bind synchronously and report the port id assigned by the kernel", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        assert.ok(socket.nl_pid > 0n);
        assert.strictEqual(socket.nl_groups, 0n);
      },
    });
  });

  it("should bind to multicast groups", async () => {
    await withSocket({
      nl_groups: RTMGRP_LINK,
      callback: async ({ socket }) => {
        assert.strictEqual(socket.nl_groups, RTMGRP_LINK);
      },
    });
  });

  it("should dump the network links", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        const messages = await socket.talk({
          header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP },
          payload: ifinfomsg({ index: 0 }),
        });

        assert.ok(messages.length > 0);
        messages.forEach((message) => {
          assert.strictEqual(message.header.nlmsg_type, RTM_NEWLINK);
          assert.strictEqual(message.header.nlmsg_pid, socket.nl_pid);
        });

        // the loopback device always has index 1
        assert.ok(messages.some((message) => {
          return indexOfLink({ payload: message.payload }) === 1;
        }));
      },
    });
  });

  it("should get a single link", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        const messages = await socket.talk({ header: { nlmsg_type: RTM_GETLINK }, payload: ifinfomsg({ index: 1 }) });

        assert.strictEqual(messages.length, 1);
        assert.strictEqual(indexOfLink({ payload: messages[0].payload }), 1);
      },
    });
  });

  it("should report errors of the kernel", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        const args = { header: { nlmsg_type: RTM_GETLINK }, payload: ifinfomsg({ index: 0x7FFF_FFFF }) };

        assert.deepStrictEqual(await socket.tryTalk(args), { errno: ENODEV, messages: [] });
        await assert.rejects(socket.talk(args), /failed with ENODEV: No such device/);
      },
    });
  });

  it("should handle many requests in parallel", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        const results = await Promise.all(Array.from({ length: 50 }, () => {
          return socket.talk({ header: { nlmsg_type: RTM_GETLINK }, payload: ifinfomsg({ index: 1 }) });
        }));

        assert.deepStrictEqual(results.map((messages) => {
          return messages.length;
        }), Array.from({ length: 50 }, () => {
          return 1;
        }));
      },
    });
  });

  it("should throw synchronously for unsupported families", () => {
    assert.throws(() => {
      openNetlinkSocket({ family: 32n });
    }, /socket\(\) failed with EPROTONOSUPPORT/);
  });

  describe("reportUnhandledError", () => {
    it("should throw the error asynchronously", async () => {
      const error = Error("unhandled");

      const listeners = process.listeners("uncaughtException");
      process.removeAllListeners("uncaughtException");

      try {
        const thrown = await new Promise((resolve) => {
          process.once("uncaughtException", resolve);
          reportUnhandledError({ error });
        });

        assert.strictEqual(thrown, error);
      } finally {
        listeners.forEach((listener) => {
          process.on("uncaughtException", listener);
        });
      }
    });
  });
});
