/* eslint-disable max-statements */
/* eslint-disable complexity */

import socket from "../../node-posix-socket-libjs/lib/index.js";
import EventEmitter from "events";
import assert from "assert";

import structures from "./structures.js";

import netlinkParser from "./parser.js";

const AF_NETLINK = 16;
const SOCK_DGRAM = 2;

const NLM_F_ECHO = 8;
const NLM_F_REQUEST = 1;
const NLM_F_MULTI = 2;
const NLM_F_DUMP = 0x300;
const NLM_F_ACK = 4;
const NLM_F_CREATE = 0x400;
const NLM_F_EXCL = 0x200;

const NLMSG_ERROR = 2;
const NLMSG_DONE = 3;

const MSG_PEEK = 0x02;
const MSG_TRUNC = 0x20;

const open = async ({ family, pid, groups }) => {
  const emitter = new EventEmitter();

  const sock = await socket.create({
    "domain": AF_NETLINK,
    "type": SOCK_DGRAM,
    "protocol": family
  });

  const netlinkAddress = structures.sockaddr_nl.create({
    "nl_family": AF_NETLINK,
    "nl_pid": pid,
    "nl_groups": groups
  });

  await sock.bind({
    "sockaddr": netlinkAddress.buffer()
  });

  const actualAddressBuffer = await sock.getsockname();

  const actualAddress = structures.sockaddr_nl.from(actualAddressBuffer);
  const { nl_pid } = actualAddress.read();

  const close = () => {
    return sock.close();
  };

  sock.on("message", (message) => {
    const parsedPackets = netlinkParser.parseMessage({ message });

    parsedPackets.forEach((packet) => {
      emitter.emit("message", packet);
    });
  });


  let seq = 1;

  const send = async ({ "header": requestedHeader, payload }) => {
    let header = Object.assign({}, requestedHeader);

    if (header.nlmsg_seq === undefined) {
      header = Object.assign({}, header, {
        "nlmsg_seq": seq
      });
      seq += 1;
    }

    if (header.nlmsg_pid === undefined) {
      header = Object.assign({}, header, {
        // "nlmsg_pid": nl_pid
      });
    }

    header = Object.assign({}, header, {
      "nlmsg_len": structures.nlmsghdr.size() + payload.length
    });

    const nlmsghdr = structures.nlmsghdr.create(header);
    const headerAsBuf = nlmsghdr.buffer();

    const data = Buffer.concat([headerAsBuf, payload]);

    const dest = structures.sockaddr_nl.create({
      "nl_family": AF_NETLINK
    });

    // TODO: flags

    await sock.sendmsg({
      data,
      "msghdr": {
        "msg_name": dest.buffer()
      }
    });
  };

  let requested = {};

  // const readNextMessage = async () => {
  //   try {
  //     const { "bytesReceived": availableBytes } = await sock.recvmsg({
  //       "data": Buffer.alloc(0),
  //       "flags": MSG_PEEK | MSG_TRUNC
  //     });
  //
  //     const { data, bytesReceived } = await sock.recvmsg({
  //       "data": Buffer.alloc(availableBytes)
  //     });
  //
  //     const message = data.slice(0, bytesReceived);
  //     // console.log("message =", message);
  //
  //     const parsedPackets = netlinkParser.parseMessage({ message });
  //
  //     parsedPackets.forEach((packet) => {
  //       emitter.emit("message", packet);
  //     });
  //
  //     // console.log("parsedPackets =", parsedPackets);
  //
  //     // emitter.emit("message", msg);
  //     if (!closed) {
  //       readNextMessage();
  //     }
  //   } catch (ex) {
  //     console.error(ex);
  //     emitter.emit("error", ex);
  //   }
  // };
  // readNextMessage();

  emitter.on("message", (message) => {
    const { header } = message;

    if (header.nlmsg_flags & NLM_F_REQUEST) {
      return;
    }

    if (header.nlmsg_seq === 0) {
      return;
    }

    const req = requested[header.nlmsg_seq];

    if (req) {
      const isLast = header.nlmsg_type === NLMSG_ERROR || header.nlmsg_type === NLMSG_DONE;

      if (isLast) {
        clearTimeout(req.schedule);
        req.resolve(req.msgs);
        Reflect.deleteProperty(requested, header.nlmsg_seq);
      } else {
        req.msgs = [...req.msgs, message];
      }
    } else {
      console.warn(`could not find pending request for seq=${header.nlmsg_seq}`);
      console.warn(`nlmsg_type = ${header.nlmsg_type}`);
    }
  });

  const tryTalk = async (message, { timeout = 10000 } = {}) => {
    if (!(message.header.nlmsg_flags & NLM_F_ACK)) {
      throw new Error(`talk only supports requests with NLM_F_ACK set`);
    }

    const packets = await new Promise((resolve, reject) => {
      const header = Object.assign({}, message.header, {
        "nlmsg_seq": seq
      });
      seq += 1;

      const schedule = setTimeout(() => {
        Reflect.deleteProperty(requested, header.nlmsg_seq);
        reject(new Error("timeout reached"));
      }, timeout);

      requested[header.nlmsg_seq] = {
        "msgs": [],
        schedule,
        resolve
      };

      send({
        header,
        "payload": message.payload
      }).catch(reject);
    });

    let errorCode = 0;

    packets.some((pkt) => {
      if (pkt.header.nlmsg_type === NLMSG_ERROR) {
        errorCode = -pkt.payload.readInt32LE(0);
        return true;
      } else {
        return false;
      }
    });

    return {
      errorCode,
      packets
    };
  };

  const talk = async (obj, options) => {
    const { errorCode, packets } = await tryTalk(obj, options);
    if (errorCode !== 0) {
      throw new Error(`received error code ${errorCode}`);
    }

    return packets;
  };

  return {
    talk,
    tryTalk,
    close,
    "on": emitter.on.bind(emitter)
  };
};

export default {
  NLM_F_ECHO,
  NLM_F_REQUEST,
  NLM_F_MULTI,
  NLM_F_DUMP,
  NLM_F_ACK,
  NLM_F_CREATE,
  NLM_F_EXCL,

  NLMSG_DONE,
  NLMSG_ERROR,

  open
};
