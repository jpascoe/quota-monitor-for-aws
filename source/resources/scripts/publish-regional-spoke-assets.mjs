import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.env.CDK_OUT_DIR ?? "cdk.out";
const bucketPrefix = process.env.SPOKE_ASSET_BUCKET_PREFIX;
const regions = (process.env.SPOKE_ASSET_REGIONS ?? "")
  .split(",")
  .map((region) => region.trim())
  .filter(Boolean);
const manifests = ["quota-monitor-ta-spoke.assets.json", "quota-monitor-sq-spoke.assets.json", "quota-monitor-sns-spoke.assets.json"];

if (!bucketPrefix || regions.length === 0) {
  throw new Error("SPOKE_ASSET_BUCKET_PREFIX and SPOKE_ASSET_REGIONS are required.");
}

const assets = new Map();
for (const manifestName of manifests) {
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, manifestName), "utf8"));
  for (const asset of Object.values(manifest.files)) {
    const destination = Object.values(asset.destinations)[0];
    assets.set(destination.objectKey, path.resolve(outputDirectory, asset.source.path));
  }
}

for (const [objectKey, assetPath] of assets) {
  let sourcePath = assetPath;
  if (statSync(assetPath).isDirectory()) {
    sourcePath = `${assetPath}.zip`;
    execFileSync("zip", ["-qr", sourcePath, "."], { cwd: assetPath, stdio: "inherit" });
  }
  if (!existsSync(sourcePath)) throw new Error(`Missing generated asset: ${sourcePath}`);

  for (const region of regions) {
    execFileSync(
      "aws",
      ["s3", "cp", sourcePath, `s3://${bucketPrefix}-${region}/${objectKey}`, "--sse", "AES256", "--region", region],
      { stdio: "inherit" }
    );
  }
}
