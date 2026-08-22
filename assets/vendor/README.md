# Vendored third-party scripts

This app has no build step (see the root `README.md`), so a browser
dependency that isn't hand-written for this repo gets vendored here as a
plain file and loaded via a `<script>` tag in `index.html`, rather than
pulled from a third-party CDN at runtime -- the whole gate shouldn't depend
on some other host staying up/unchanged just to load.

## msal-browser.min.js

`@azure/msal-browser` v5.19.0 (MIT license, see `msal-browser.LICENSE.txt`),
the UMD build (`lib/msal-browser.min.js` in the published npm package),
unmodified except for this note. Attaches `window.msal` (`PublicClientApplication`,
etc.) -- see `assets/js/offline/onedrive-library.js` for how it's used
(the OneDrive-folder-link gate source, PBE_2026_2027/AGENTS.md).

To update: `npm view @azure/msal-browser version`, download
`https://registry.npmjs.org/@azure/msal-browser/-/msal-browser-<version>.tgz`,
take `package/lib/msal-browser.min.js` and `package/LICENSE` from the
tarball, replace both files here.
