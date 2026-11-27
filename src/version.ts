/**
 * The app's version, shown in the status bar. Set by the build from package.json and git.
 * Bump "version" in package.json for each release (see CHANGELOG.md).
 */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;

export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;
export const APP_BUILT = __APP_BUILT__;
