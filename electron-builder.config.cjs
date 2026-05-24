/**
 * electron-builder 入口：基于 electron-builder.json5，并在运行时注入 mac.notarize.teamId。
 * @electron/notarize 在使用 Apple ID + 专用密码时要求 teamId，不能仅用 notarize: true。
 */
const fs = require('fs');
const path = require('path');

function loadJson5(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  text = text.replace(/^\s*\/\/.*$/gm, '');
  text = text.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text);
}

const base = loadJson5(path.join(__dirname, 'electron-builder.json5'));
const teamId = process.env.APPLE_TEAM_ID?.trim();
const speechCliPath = path.join(__dirname, 'native', 'speech-cli', 'build', 'AgentOS Speech Helper.app');

if (fs.existsSync(speechCliPath)) {
  base.extraResources = [
    ...(Array.isArray(base.extraResources) ? base.extraResources : []),
    {
      from: speechCliPath,
      to: path.join('speech', 'AgentOS Speech Helper.app'),
    },
  ];
}

const hasAppleNotarizeCreds =
  Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD) ||
  Boolean(
    process.env.APPLE_API_KEY &&
      process.env.APPLE_API_KEY_ID &&
      process.env.APPLE_API_ISSUER,
  );

if (teamId) {
  base.mac = { ...base.mac, notarize: { teamId } };
} else if (hasAppleNotarizeCreds) {
  console.warn(
    'APPLE_TEAM_ID is not set — skipping macOS notarization. Add it to GitHub Secrets or release-env.local.sh.',
  );
  base.mac = { ...base.mac, notarize: false };
}

module.exports = base;
