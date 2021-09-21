import structures from "./structures.js";

const align4 = (addr) => {
  return (addr + 3) & ~3;
};

const parseNetlinkMessage = ({ message }) => {
  const parsed = structures.nlmsghdr.parse(message);

  const header = {
    "nlmsg_type": parsed.nlmsg_type,
    "nlmsg_flags": parsed.nlmsg_flags,
    "nlmsg_seq": parsed.nlmsg_seq,
    "nlmsg_pid": parsed.nlmsg_pid
  };

  const payloadOffset = align4(structures.nlmsghdr.size);
  const payloadLength = parsed.nlmsg_len - BigInt(payloadOffset);

  if (payloadLength < 0) {
    throw new Error("negative payload length, packet malformed");
  }

  const payload = message.slice(payloadOffset, payloadOffset + Number(payloadLength));
  const space = align4(payloadOffset + payload.length);

  return {
    header,
    payload,
    space
  };
};

const parseMessage = ({ message }) => {
  let result = [];

  let remaining = message;
  while (remaining.length > 0) {
    const { header, payload, space } = parseNetlinkMessage({ "message": remaining });
    const parsed = {
      header,
      payload
    };

    result = [...result, parsed ];

    remaining = remaining.slice(space);
  }

  return result;
};

export default {
  parseMessage
};
