// Lists the network interfaces of the host, like `ip link show`.
//
//   node examples/list-links.ts

import { NETLINK_ROUTE, NLM_F_DUMP } from "../lib/index.ts";
import { openNetlinkSocket } from "./open-netlink-socket.ts";

// <linux/rtnetlink.h> and <linux/if_link.h>
const RTM_GETLINK = 18n;
const IFLA_IFNAME = 3;
const IFINFOMSG_SIZE = 16;
const RTA_HEADER_SIZE = 4;

const align4 = ({ length }: { length: number }) => {
  return Math.ceil(length / 4) * 4;
};

// walks the struct rtattr list following struct ifinfomsg and returns the interface name
const interfaceNameOf = ({ payload }: { payload: Uint8Array }) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  let offset = IFINFOMSG_SIZE;

  while (offset + RTA_HEADER_SIZE <= payload.length) {
    const rtaLength = view.getUint16(offset, true);
    const rtaType = view.getUint16(offset + 2, true);

    if (rtaLength < RTA_HEADER_SIZE) {
      break;
    }

    if (rtaType === IFLA_IFNAME) {
      // the name is a null terminated string
      const name = payload.subarray(offset + RTA_HEADER_SIZE, offset + rtaLength - 1);
      return new TextDecoder().decode(name);
    }

    offset += align4({ length: rtaLength });
  }

  return undefined;
};

const { socket, close } = openNetlinkSocket({ family: NETLINK_ROUTE });

try {
  const links = await socket.talk({
    header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP },
    payload: new Uint8Array(IFINFOMSG_SIZE),
  });

  links.forEach(({ payload }) => {
    const index = new DataView(payload.buffer, payload.byteOffset).getInt32(4, true);
    console.log(`${index}: ${interfaceNameOf({ payload })}`);
  });
} finally {
  close();
}
