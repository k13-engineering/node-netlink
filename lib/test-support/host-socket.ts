import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import {
  createKernelAbiFor,
  createLinuxKernelInterface,
  createPo6Api,
  hostAbi
} from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import { AF_NETLINK } from "../constants.ts";
import { formatNetlinkAddress } from "../structures.ts";

// <linux/net.h> and <asm-generic/fcntl.h>
const SOCK_RAW = 3n;
const SOCK_NONBLOCK = 0o4000n;
const SOCK_CLOEXEC = 0o2000000n;

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });

const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi,
  memory: { pinBuffer },
});

/**
 * Opens and binds a real netlink socket, like users of the library do.
 */
const openHostNetlinkSocket = ({ family, nl_groups = 0n }: { family: bigint, nl_groups?: bigint }) => {
  const { errno: socketErrno, fd } = po6.socket({
    domain: AF_NETLINK,
    type: SOCK_RAW | SOCK_NONBLOCK | SOCK_CLOEXEC,
    protocol: family,
  });

  if (socketErrno !== undefined) {
    throw po6.createErrorFromErrno({ operation: "socket()", errno: socketErrno });
  }

  const { errno: bindErrno } = po6.bind({
    fd,
    sockaddr: formatNetlinkAddress({ address: { nl_pid: 0n, nl_groups } }),
  });

  if (bindErrno !== undefined) {
    po6.close({ fd });
    throw po6.createErrorFromErrno({ operation: "bind()", errno: bindErrno });
  }

  return {
    fd,
    close: () => {
      po6.close({ fd });
    },
  };
};

export {
  po6,
  kernelAbi,
  createPoller,
  openHostNetlinkSocket,
};
