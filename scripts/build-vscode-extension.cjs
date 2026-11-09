/**
 * 把 editors/vscode/ 打成 resources/editors/hpp-bridge.vsix。
 *
 * 不引 @vscode/vsce：vsix 就是一个 zip，两个清单文件 + extension/ 目录，
 * 手搓出来省掉一条构建工具链（也避免为打包再装一堆依赖）。
 */
const AdmZip = require("adm-zip");
const { mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");

const root = resolve(__dirname, "..");
const sourceDir = join(root, "editors", "vscode");
const outputDir = join(root, "resources", "editors");
const outputPath = join(outputDir, "hpp-bridge.vsix");

const manifest = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
const engine = manifest.engines && manifest.engines.vscode ? manifest.engines.vscode : "^1.80.0";

const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".xml" ContentType="text/xml" />
</Types>
`;

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(manifest.name)}" Version="${escapeXml(manifest.version)}" Publisher="${escapeXml(manifest.publisher)}" />
    <DisplayName>${escapeXml(manifest.displayName || manifest.name)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(manifest.description || "")}</Description>
    <Tags>hpp,chat</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(engine)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const zip = new AdmZip();
for (const file of ["package.json", "extension.js", "README.md"]) {
  zip.addLocalFile(join(sourceDir, file), "extension");
}
zip.addFile("[Content_Types].xml", Buffer.from(contentTypes, "utf8"));
zip.addFile("extension.vsixmanifest", Buffer.from(vsixManifest, "utf8"));

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, zip.toBuffer());
console.log(`[editors] ${outputPath} (${manifest.name}@${manifest.version})`);
