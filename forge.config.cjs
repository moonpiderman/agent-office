const canSign = Boolean(process.env.MACOS_CERTIFICATE);
const canNotarize = Boolean(
  process.env.APPLE_ID &&
  process.env.APPLE_ID_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

const packagerConfig = {
  asar: true,
  appBundleId: 'io.github.moonpiderman.agent-office',
  appCategoryType: 'public.app-category.developer-tools',
  icon: 'assets/icon',
};

if (canSign) packagerConfig.osxSign = {};
if (canSign && canNotarize) {
  packagerConfig.osxNotarize = {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
}

module.exports = {
  packagerConfig,
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { format: 'ULFO' },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
};
