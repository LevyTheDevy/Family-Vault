const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Writes a network_security_config.xml that explicitly allows cleartext (HTTP)
// traffic. Needed because Android 9+ blocks HTTP by default, and some Expo
// plugins generate a networkSecurityConfig that overrides usesCleartextTraffic
// in the manifest, silently breaking local-network HTTP connections.
function withNetworkSecurityXml(config) {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'res', 'xml'
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'network_security_config.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>`
      );
      return config;
    },
  ]);
}

function withManifestAttributes(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    app.$['android:usesCleartextTraffic'] = 'true';
    app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });
}

module.exports = (config) => withManifestAttributes(withNetworkSecurityXml(config));
