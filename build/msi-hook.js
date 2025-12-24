const fs = require('fs');
const path = require('path');

exports.default = async function msiProjectCreated(createdPath) {
  console.log('MSI Hook: Modifying WiX project for enterprise deployment...');

  const wxsPath = createdPath;

  if (!fs.existsSync(wxsPath)) {
    console.error('MSI Hook: WiX file not found:', wxsPath);
    return;
  }

  let content = fs.readFileSync(wxsPath, 'utf8');

  const registryComponent = `
    <Component Id="RegistryMarker" Guid="*">
      <RegistryKey Root="HKCU" Key="Software\\CONV2">
        <RegistryValue Name="InstalledViaMsi" Type="integer" Value="1" KeyPath="yes" />
        <RegistryValue Name="DisableAutoUpdates" Type="integer" Value="1" />
      </RegistryKey>
    </Component>`;

  const directoryClosePattern = /<\/Directory>\s*<\/Fragment>/;
  if (directoryClosePattern.test(content)) {
    content = content.replace(
      directoryClosePattern,
      `</Directory>\n    ${registryComponent}\n  </Fragment>`
    );
  }

  const featurePattern = /<Feature[^>]*>/;
  const featureMatch = content.match(featurePattern);
  if (featureMatch) {
    const insertPoint = content.indexOf('</Feature>');
    if (insertPoint !== -1) {
      content = content.slice(0, insertPoint) +
        '\n      <ComponentRef Id="RegistryMarker" />' +
        content.slice(insertPoint);
    }
  }

  const uiRef = `
  <UIRef Id="WixUI_Minimal" />
  <WixVariable Id="WixUILicenseRtf" Value="$(var.ProjectDir)\\..\\..\\LICENSE.rtf" />`;

  const licenseRtfPath = path.join(__dirname, '..', 'LICENSE.rtf');
  if (fs.existsSync(licenseRtfPath)) {
    const productClosePattern = /<\/(Product|Package)>/;
    if (productClosePattern.test(content)) {
      content = content.replace(
        productClosePattern,
        `${uiRef}\n</$1>`
      );
    }
  }

  fs.writeFileSync(wxsPath, content, 'utf8');
  console.log('MSI Hook: WiX project modified successfully');
  console.log('MSI Hook: Auto-updates disabled for enterprise deployment');
};
