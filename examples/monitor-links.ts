// Prints link notifications of the kernel until interrupted, like `ip monitor link`.
// Plug in a network cable or run `ip link set dev <name> down` to see events.
//
//   node examples/monitor-links.ts

import { NETLINK_ROUTE, openNetlinkSocket } from "../lib/index.ts";

// <linux/rtnetlink.h>
const RTM_NEWLINK = 16n;
const RTM_DELLINK = 17n;
const RTMGRP_LINK = 1n;

const socket = openNetlinkSocket({
  family: NETLINK_ROUTE,
  nl_groups: RTMGRP_LINK,
  onMessage: ({ message }) => {
    const { nlmsg_type } = message.header;
    const index = new DataView(message.payload.buffer, message.payload.byteOffset).getInt32(4, true);

    if (nlmsg_type === RTM_NEWLINK) {
      console.log(`link ${index} added or changed`);
    } else if (nlmsg_type === RTM_DELLINK) {
      console.log(`link ${index} removed`);
    }
  },
  onError: ({ error }) => {
    console.error(error);
  },
});

console.log(`listening for link events on port id ${socket.nl_pid}, press Ctrl+C to stop`);

process.once("SIGINT", () => {
  socket.close();
});
