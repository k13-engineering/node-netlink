import netlink from "../lib/index.js";

const NETLINK_ROUTE = 0;

process.nextTick(async () => {
  try {
    const nl = await netlink.open({
      "family": NETLINK_ROUTE
    });
    nl.close();
  } catch (ex) {
    console.error(ex);
  }
});
