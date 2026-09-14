import packageJson from "../package.json" with { type: "json" };

export const WEBOT_VERSION = String(packageJson.version);
