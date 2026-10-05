import { define, type TAbi } from "ya-struct";
import { hostAbi } from "po6";
import { AF_NETLINK } from "./constants.ts";

// struct sockaddr_nl from <linux/netlink.h>
const sockaddrNlDefinition = {
  type: "struct",
  packed: false,
  fixedAbi: {},
  fields: [
    { name: "nl_family", definition: { type: "c-type", cType: "unsigned short", fixedAbi: {} } },
    { name: "nl_pad", definition: { type: "c-type", cType: "unsigned short", fixedAbi: {} } },
    { name: "nl_pid", definition: { type: "integer", sizeInBits: 32, signed: false, fixedAbi: {} } },
    { name: "nl_groups", definition: { type: "integer", sizeInBits: 32, signed: false, fixedAbi: {} } },
  ],
} as const;

// struct nlmsghdr from <linux/netlink.h>
const nlmsghdrDefinition = {
  type: "struct",
  packed: false,
  fixedAbi: {},
  fields: [
    { name: "nlmsg_len", definition: { type: "integer", sizeInBits: 32, signed: false, fixedAbi: {} } },
    { name: "nlmsg_type", definition: { type: "integer", sizeInBits: 16, signed: false, fixedAbi: {} } },
    { name: "nlmsg_flags", definition: { type: "integer", sizeInBits: 16, signed: false, fixedAbi: {} } },
    { name: "nlmsg_seq", definition: { type: "integer", sizeInBits: 32, signed: false, fixedAbi: {} } },
    { name: "nlmsg_pid", definition: { type: "integer", sizeInBits: 32, signed: false, fixedAbi: {} } },
  ],
} as const;

// struct nlmsgerr from <linux/netlink.h>, the payload of NLMSG_ERROR
const nlmsgerrDefinition = {
  type: "struct",
  packed: false,
  fixedAbi: {},
  fields: [
    { name: "error", definition: { type: "c-type", cType: "int", fixedAbi: {} } },
    { name: "msg", definition: nlmsghdrDefinition },
  ],
} as const;

const sockaddrNl = define({ definition: sockaddrNlDefinition });
const nlmsghdr = define({ definition: nlmsghdrDefinition });
const nlmsgerr = define({ definition: nlmsgerrDefinition });

const createNetlinkStructuresFor = ({ abi }: { abi: TAbi }) => {
  return {
    abi,
    sockaddrNl: sockaddrNl.parser({ abi }),
    nlmsghdr: nlmsghdr.parser({ abi }),
    nlmsgerr: nlmsgerr.parser({ abi }),
  };
};

type TNetlinkStructures = ReturnType<typeof createNetlinkStructuresFor>;

const hostStructures = createNetlinkStructuresFor({ abi: hostAbi });

/**
 * Formats a struct sockaddr_nl, e.g. to bind() a netlink socket.
 */
const formatNetlinkAddress = ({ address, structures = hostStructures }: {
  address: { nl_pid: bigint, nl_groups: bigint },
  structures?: TNetlinkStructures,
}) => {
  return structures.sockaddrNl.format({
    value: {
      nl_family: AF_NETLINK,
      nl_pad: 0n,
      ...address,
    },
  });
};

export {
  sockaddrNlDefinition,
  nlmsghdrDefinition,
  nlmsgerrDefinition,

  createNetlinkStructuresFor,
  hostStructures,
  formatNetlinkAddress,
};

export type {
  TNetlinkStructures,
};
