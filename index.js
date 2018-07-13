const assert = require("assert");
const fs = require("fs");
const EventEmitter = require("events");

const native = require("./build/Release/netlink-native.node");

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

const open = (opts) => {
  const family = opts.family;
  assert(typeof family === "number" && !isNaN(family) && family >= 0, "opts.family should be a positive integer");

  const emitter = new EventEmitter();

  const n = new native.NetlinkSocket(opts.family, (msg) => {
    emitter.emit("message", msg);
  });

  let requested = {};

  emitter.on("message", (msg) => {
    // console.log("msg =", msg);

    msg.forEach((part) => {
      if (!(part.header.nlmsg_flags & NLM_F_REQUEST)) {
        if (part.header.nlmsg_seq > 0) {
          const req = requested[part.header.nlmsg_seq];

          if (req) {
            req.multi |= part.header.nlmsg_flags & NLM_F_MULTI;

            if (part.header.nlmsg_type === NLMSG_ERROR) {
              const err = part.payload.readInt32LE(0);

              if (err === 0) {
                req.cb(null, []);
              } else {
                req.cb(err);
              }
            } else {
              if (req.multi) {
                req.msgs = req.msgs.concat([part]);

                if (part.header.nlmsg_type === NLMSG_DONE) {
                  req.cb(null, req.msgs);
                }
              } else {
                req.cb(null, [part]);
              }
            }
          } else {
            console.warn("could not find pending request for seq=" + part.header.nlmsg_seq);
          }
        }
      }
    });
  });

  let seq = 1;

  const send = (obj) => new Promise((resolve, reject) => {
    assert(typeof obj.header === "object" &&
      !Buffer.isBuffer(obj.header) &&
      !Array.isArray(obj.header), "header must be an object");

    let header = Object.assign({}, obj.header);

    if (header.nlmsg_seq === undefined) {
      header = Object.assign({}, header, {
        "nlmsg_seq": seq
      });
      seq += 1;
    }

    n.send(header, obj.payload, obj.flags, (err) => {
      resolve();
    });
  });

  const talk = (obj) => {
    return new Promise((resolve, reject) => {
      const header = Object.assign({}, obj.header, {
        "nlmsg_seq": seq
      });
      seq += 1;

      const schedule = setTimeout(() => {
        Reflect.deleteProperty(requested, header.nlmsg_seq);
        reject(new Error("timeout reached"));
      }, obj.timeout || 10000);

      requested[header.nlmsg_seq] = {
        "msgs": [],
        "multi": false,
        "schedule": schedule,
        "cb": (err, data) => {
          clearTimeout(schedule);
          Reflect.deleteProperty(requested, header.nlmsg_seq);

          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        }
      };

      send({
        "header": header,
        "payload": obj.payload
      }).catch(reject);
    });
  };


  return Object.freeze({
    send,
    talk,
    "on": emitter.on.bind(emitter),
    "once": emitter.once.bind(emitter),
    "close": () => n.close()
  });
};

module.exports = {
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
