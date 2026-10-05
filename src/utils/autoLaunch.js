const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function getLaunchInfo(app) {
  return {
    path: app.getPath("exe"),
    args: app.isPackaged ? [] : [app.getAppPath()],
  };
}

function getLinuxAutostartPath(appId) {
  const safeName = String(appId || "voice-desktop")
    .replace(/[^a-z0-9._-]/gi, "-")
    .toLowerCase();

  return path.join(os.homedir(), ".config", "autostart", `${safeName}.desktop`);
}

function quoteDesktopExec(value) {
  const escaped = String(value).replace(/[\\"`$]/g, "\\$&");
  return `"${escaped}"`;
}

function isEnabled(app, appId) {
  const launchInfo = getLaunchInfo(app);

  if (process.platform === "win32") {
    return app.getLoginItemSettings(launchInfo).openAtLogin;
  }

  if (process.platform === "darwin") {
    return app.getLoginItemSettings().openAtLogin;
  }

  if (process.platform === "linux") {
    return fs.existsSync(getLinuxAutostartPath(appId));
  }

  return false;
}

function setEnabled(app, appId, appName, enabled) {
  const launchInfo = getLaunchInfo(app);

  if (process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: launchInfo.path,
      args: launchInfo.args,
      name: appName,
    });
    return;
  }

  if (process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }

  if (process.platform === "linux") {
    const desktopPath = getLinuxAutostartPath(appId);

    if (!enabled) {
      fs.rmSync(desktopPath, { force: true });
      return;
    }

    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });

    const execParts = [launchInfo.path, ...launchInfo.args]
      .map(quoteDesktopExec)
      .join(" ");

    const desktopFile = [
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.0",
      `Name=${appName}`,
      `Exec=${execParts}`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n");

    fs.writeFileSync(desktopPath, desktopFile, { encoding: "utf8", mode: 0o600 });
  }
}

module.exports = {
  isEnabled,
  setEnabled,
};
