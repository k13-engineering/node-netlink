import struct from "ya-struct";

const sockaddr_nl = struct.define(({ field }) => {
  field.UInt16("nl_family");
  field.UInt16("nl_pad");
  field.UInt32("nl_pid");
  field.UInt32("nl_groups");
}).forHost();

const nlmsghdr = struct.define(({ field }) => {
  field.UInt32("nlmsg_len");
  field.UInt16("nlmsg_type");
  field.UInt16("nlmsg_flags");
  field.UInt32("nlmsg_seq");
  field.UInt32("nlmsg_pid");
}).forHost();

export default {
  sockaddr_nl,
  nlmsghdr
};
