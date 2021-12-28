import netlink from "../lib/index.js";

const NETLINK_ROUTE = 0;

netlink.open({
  family: NETLINK_ROUTE
}).then((nl) => {
  nl.close();
}).catch((err) => {
  console.error(err);
});
