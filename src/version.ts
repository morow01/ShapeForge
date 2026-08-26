import packageInfo from "../package.json";

// The display name is a presentation choice, kept separate from the npm
// package name (which stays lowercase/hyphenated by convention).
export const APP_NAME = "ShapeForge";

// Import package.json directly so Vite's normal hot-reload graph sees version
// changes immediately; the development server no longer needs restarting.
export const APP_VERSION = packageInfo.version;
