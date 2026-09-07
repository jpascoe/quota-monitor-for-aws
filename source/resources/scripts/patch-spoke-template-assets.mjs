import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = process.env.CDK_OUT_DIR ?? "cdk.out";
const sourceBucket = process.env.SOLUTION_BUCKET;
const bucketPrefix = process.env.SPOKE_ASSET_BUCKET_PREFIX;

if (!sourceBucket || !bucketPrefix) {
  throw new Error("SOLUTION_BUCKET and SPOKE_ASSET_BUCKET_PREFIX are required.");
}

const templates = ["quota-monitor-ta-spoke.template.json", "quota-monitor-sq-spoke.template.json", "quota-monitor-sns-spoke.template.json"];
const regionalBucket = { "Fn::Sub": `${bucketPrefix}-\${AWS::Region}` };

function replaceAssetBuckets(value) {
  if (Array.isArray(value)) return value.map(replaceAssetBuckets);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const isBootstrapAssetBucket = typeof child === "object" && child?.["Fn::Sub"]?.startsWith("cdk-hnb659fds-assets-");
    result[key] = key === "S3Bucket" && (child === sourceBucket || isBootstrapAssetBucket) ? regionalBucket : replaceAssetBuckets(child);
  }
  return result;
}

for (const template of templates) {
  const file = path.join(outputDirectory, template);
  const original = JSON.parse(await readFile(file, "utf8"));
  const patched = replaceAssetBuckets(original);
  await writeFile(file, `${JSON.stringify(patched, null, 2)}\n`);
}
