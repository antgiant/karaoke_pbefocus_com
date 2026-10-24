// Public identifiers for the shared "PBE Focus" sign-in registrations (docs/unified-storage-plan.md, Phase 0). None of these is a secret:
// client IDs are meant to ship in browser code, and the Picker key only works from the registered pbefocus.com origins.

export const MICROSOFT_CLIENT_ID = "86d550b4-029b-4b45-abf0-c8a56aa5bffe";

export const GOOGLE_CLIENT_ID = "332648473500-9b047fgob7vmt7j0nm3ut6gguumsqlur.apps.googleusercontent.com";
export const GOOGLE_API_KEY = "AIzaSyAXzux3Lbfd_fHp2efZTH7E-m5EKLZCxdg";
/** The Google Cloud project number, which the Picker calls the App ID. */
export const GOOGLE_APP_ID = "332648473500";

/** Folder name suggested when the person lets the app create their data folder. */
export const DEFAULT_FOLDER_NAME = "PBE Focus data";
