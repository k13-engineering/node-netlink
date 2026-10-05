// values from <linux/netlink.h> and <linux/socket.h>, shared by all Linux architectures

const AF_NETLINK = 16n;

// netlink protocol families, passed as `family` when opening a socket
const NETLINK_ROUTE = 0n;
const NETLINK_UNUSED = 1n;
const NETLINK_USERSOCK = 2n;
const NETLINK_FIREWALL = 3n;
const NETLINK_SOCK_DIAG = 4n;
const NETLINK_NFLOG = 5n;
const NETLINK_XFRM = 6n;
const NETLINK_SELINUX = 7n;
const NETLINK_ISCSI = 8n;
const NETLINK_AUDIT = 9n;
const NETLINK_FIB_LOOKUP = 10n;
const NETLINK_CONNECTOR = 11n;
const NETLINK_NETFILTER = 12n;
const NETLINK_IP6_FW = 13n;
const NETLINK_DNRTMSG = 14n;
const NETLINK_KOBJECT_UEVENT = 15n;
const NETLINK_GENERIC = 16n;
const NETLINK_SCSITRANSPORT = 18n;
const NETLINK_ECRYPTFS = 19n;
const NETLINK_RDMA = 20n;
const NETLINK_CRYPTO = 21n;
const NETLINK_SMC = 22n;

// flags of struct nlmsghdr
const NLM_F_REQUEST = 0x01n;
const NLM_F_MULTI = 0x02n;
const NLM_F_ACK = 0x04n;
const NLM_F_ECHO = 0x08n;
const NLM_F_DUMP_INTR = 0x10n;
const NLM_F_DUMP_FILTERED = 0x20n;

// modifiers to GET requests
const NLM_F_ROOT = 0x100n;
const NLM_F_MATCH = 0x200n;
const NLM_F_ATOMIC = 0x400n;
const NLM_F_DUMP = 0x300n;

// modifiers to NEW requests
const NLM_F_REPLACE = 0x100n;
const NLM_F_EXCL = 0x200n;
const NLM_F_CREATE = 0x400n;
const NLM_F_APPEND = 0x800n;

// modifiers to DELETE requests
const NLM_F_NONREC = 0x100n;
const NLM_F_BULK = 0x200n;

// flags for ACK messages
const NLM_F_CAPPED = 0x100n;
const NLM_F_ACK_TLVS = 0x200n;

// reserved control message types
const NLMSG_NOOP = 0x1n;
const NLMSG_ERROR = 0x2n;
const NLMSG_DONE = 0x3n;
const NLMSG_OVERRUN = 0x4n;
const NLMSG_MIN_TYPE = 0x10n;

export {
  AF_NETLINK,

  NETLINK_ROUTE,
  NETLINK_UNUSED,
  NETLINK_USERSOCK,
  NETLINK_FIREWALL,
  NETLINK_SOCK_DIAG,
  NETLINK_NFLOG,
  NETLINK_XFRM,
  NETLINK_SELINUX,
  NETLINK_ISCSI,
  NETLINK_AUDIT,
  NETLINK_FIB_LOOKUP,
  NETLINK_CONNECTOR,
  NETLINK_NETFILTER,
  NETLINK_IP6_FW,
  NETLINK_DNRTMSG,
  NETLINK_KOBJECT_UEVENT,
  NETLINK_GENERIC,
  NETLINK_SCSITRANSPORT,
  NETLINK_ECRYPTFS,
  NETLINK_RDMA,
  NETLINK_CRYPTO,
  NETLINK_SMC,

  NLM_F_REQUEST,
  NLM_F_MULTI,
  NLM_F_ACK,
  NLM_F_ECHO,
  NLM_F_DUMP_INTR,
  NLM_F_DUMP_FILTERED,

  NLM_F_ROOT,
  NLM_F_MATCH,
  NLM_F_ATOMIC,
  NLM_F_DUMP,

  NLM_F_REPLACE,
  NLM_F_EXCL,
  NLM_F_CREATE,
  NLM_F_APPEND,

  NLM_F_NONREC,
  NLM_F_BULK,

  NLM_F_CAPPED,
  NLM_F_ACK_TLVS,

  NLMSG_NOOP,
  NLMSG_ERROR,
  NLMSG_DONE,
  NLMSG_OVERRUN,
  NLMSG_MIN_TYPE,
};
