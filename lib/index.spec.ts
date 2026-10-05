import assert from "node:assert";
import { describe, it } from "mocha";
import {
  createNetlinkSocket,
  createPo6NetlinkTransport,
  NETLINK_ROUTE,
  NLM_F_DUMP,
  type TNetlinkSocket
} from "./index.ts";
import {
  createPoller,
  kernelAbi,
  openHostNetlinkSocket,
  po6
} from "./test-support/host-socket.ts";

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

const ENODEV = 19;

const attach = ({ fd }: { fd: number }) => {
  const transport = createPo6NetlinkTransport({ fd, po6, kernelAbi, createPoller });
  return createNetlinkSocket({ transport });
};

const withSocket = async ({ nl_groups, callback }: {
  nl_groups?: bigint,
  callback: (args: { socket: TNetlinkSocket }) => Promise<void>,
}) => {
  const hostSocket = openHostNetlinkSocket({ family: NETLINK_ROUTE, nl_groups });

  try {
    const socket = attach({ fd: hostSocket.fd });

    try {
      await callback({ socket });
    } finally {
      socket.detach();
    }
  } finally {
    hostSocket.close();
  }
};

describe("node-netlink on the host kernel", () => {
  it("should report the port id assigned by the kernel", async () => {
    await withSocket({
      callback: async ({ socket }) => {
        assert.ok(socket.nl_pid > 0n);
        assert.strictEqual(socket.nl_groups, 0n);
      },
    });
  });

  it("should report the multicast groups the socket is bound to", async () => {
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
        await assert.rejects(socket.talk(args), /netlink request of type 18 failed with ENODEV/);
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

  it("should leave the socket open when detaching", async () => {
    const hostSocket = openHostNetlinkSocket({ family: NETLINK_ROUTE });

    try {
      const first = attach({ fd: hostSocket.fd });
      first.detach();

      // the file descriptor is still usable, so a new netlink socket can be attached to it
      const second = attach({ fd: hostSocket.fd });

      try {
        const messages = await second.talk({ header: { nlmsg_type: RTM_GETLINK }, payload: ifinfomsg({ index: 1 }) });
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(second.nl_pid, first.nl_pid);
      } finally {
        second.detach();
      }
    } finally {
      hostSocket.close();
    }
  });
});
