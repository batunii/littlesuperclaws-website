/* Little Super Claws — runtime config.

   No API keys here, ever.

   The pregenerated Dublin worlds are served from worlds/ as plain static
   files (see js/worlds-local.js + tools/vendor_worlds.py), so the public
   site needs no credential and no backend.

   `base` is only needed for the extras: worlds that were never vendored,
   and live "type any location" generation. It points at the Cloudflare
   Worker in proxy/, which holds the key server-side. Leave it null to run
   fully static — free-typed locations then fall back to the postcard view. */
window.LSC_CONFIG = {
  worldLabs: {
    base: null,
    // base: 'https://lsc-worldlabs-proxy.YOUR-SUBDOMAIN.workers.dev/marble/v1',
  },
};
