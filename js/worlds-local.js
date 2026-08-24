/* Locally vendored Marble assets — regenerate with:
     WORLDLABS_API_KEY=... python tools/vendor_worlds.py

   Empty until you run that. While it is empty the site behaves as before:
   worlds are fetched through the proxy (js/config.js → worldLabs.base), and
   without a proxy the modal falls back to its postcard view.

   Once populated, every listed world is served from worlds/ as same-origin
   static files — no API key, no proxy, no Cloudflare account. */
window.LSC_WORLDS_LOCAL = {};
