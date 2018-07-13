const netlink = require("../index.js");

const NETLINK_ROUTE = 0;

describe("opening", function () {
  this.timeout(5000);

  describe("normal case", () => {
    it("should open without error", () => {
      const nl = netlink.open({
        "family": NETLINK_ROUTE
      });
      nl.close();
    });
  });
});
