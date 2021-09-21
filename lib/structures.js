// import Struct from "struct";
//
// const sockaddr_nl = Struct()
//   .word16Ule("nl_family")
//   .word16Ule("nl_pad")
//   .word32Ule("nl_pid")
//   .word32Ule("nl_groups");
//
// const nlmsghdr = Struct()
//   .word32Ule("nlmsg_len")
//   .word16Ule("nlmsg_type")
//   .word16Ule("nlmsg_flags")
//   .word32Ule("nlmsg_seq")
//   .word32Ule("nlmsg_pid");

import struct from "../../node-ya-struct/lib/index.js";

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
