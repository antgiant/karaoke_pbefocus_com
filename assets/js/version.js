// The deployed version shown in the footer. It reads "dev" in the repo and
// is stamped automatically (build date + short SHA of the pushed commit) by
// .github/workflows/stamp-version.yml on every push to main -- never edit by
// hand. "dev" in the footer therefore means a local checkout, or a deploy the
// workflow hasn't stamped yet.
export const APP_VERSION = "dev";

const el = document.getElementById("appVersion");
if (el) {
  el.textContent = APP_VERSION === "dev" ? "dev build" : `v${APP_VERSION}`;
  if (document.lastModified) el.title = `App version. Page last modified: ${document.lastModified}`;
}
