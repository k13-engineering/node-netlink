{
  "targets": [
    {
      "target_name": "netlink-native",
      "sources": [ "native/netlink.cc" ],
      "include_dirs": [
        "<!(node -e \"require('nan')\")"
      ]
    }
  ]
}