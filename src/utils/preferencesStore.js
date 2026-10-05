const fs = require("node:fs");
const path = require("node:path");

/**
 * Tiny JSON-backed preference store.
 *
 * This intentionally uses Electron Store's historical default file name
 * (config.json inside app.getPath("userData")) so existing users keep their
 * settings without a migration, while avoiding a production dependency.
 */
module.exports = class PreferencesStore {
  constructor(app) {
    this.filePath = path.join(app.getPath("userData"), "config.json");
    this.data = this.#read();
  }

  get(key, fallbackValue) {
    if (!key) return this.data;

    const segments = String(key).split(".");
    let value = this.data;

    for (const segment of segments) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.prototype.hasOwnProperty.call(value, segment)
      ) {
        return fallbackValue;
      }

      value = value[segment];
    }

    return value === undefined ? fallbackValue : value;
  }

  set(key, value) {
    const segments = String(key).split(".").filter(Boolean);
    if (segments.length === 0) {
      throw new TypeError("Preference key must not be empty.");
    }

    let target = this.data;

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];

      if (
        target[segment] === null ||
        typeof target[segment] !== "object" ||
        Array.isArray(target[segment])
      ) {
        target[segment] = {};
      }

      target = target[segment];
    }

    target[segments.at(-1)] = value;
    this.#write();
  }

  #read() {
    try {
      if (!fs.existsSync(this.filePath)) return {};

      const contents = fs.readFileSync(this.filePath, "utf8");
      if (!contents.trim()) return {};

      const parsed = JSON.parse(contents);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (error) {
      console.warn("Unable to read saved preferences; using defaults:", error);
      return {};
    }
  }

  #write() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        `${JSON.stringify(this.data, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      console.error("Unable to save preferences:", error);
    }
  }
};
