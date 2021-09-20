/* global describe */
/* global it */

// import netlink from "../index.js";
import netlink from "../lib/index.js";

const NETLINK_ROUTE = 0;

describe("opening", function () {
  this.timeout(5000);

  describe("normal case", () => {
    it("should open without error", async () => {
      const nl = await netlink.open({
        "family": NETLINK_ROUTE
      });
      nl.close();
    });
  });
});
