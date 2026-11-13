#!/usr/bin/env node
// Metadata-only StackSet control. Never supplies a template, parameters or instance targets.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACCOUNT = "817495191110", REGION = "us-east-1", STACK_SET = "QM-SQ-Spoke-StackSet";
const STACK_SETS = new Set([STACK_SET, "QM-TA-Spoke-StackSet", "QM-SNS-Spoke-StackSet"]);
const stable = (value) => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const hash = (value) => createHash("sha256").update(stable(value)).digest("hex");
const sorted = (items, key) => [...items].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

export function snapshotStackSet(stackSet, instances, expectedName = STACK_SET) {
  if (!STACK_SETS.has(expectedName) || stackSet.StackSetName !== expectedName || stackSet.PermissionModel !== "SERVICE_MANAGED" || stackSet.Status !== "ACTIVE") {
    throw new Error("Unexpected StackSet identity, permission model or status");
  }
  if (!stackSet.StackSetARN?.includes(`:${REGION}:${ACCOUNT}:stackset/${expectedName}:`)) throw new Error("Unexpected StackSet owner or region");
  if (typeof stackSet.TemplateBody !== "string" || !stackSet.TemplateBody.length) throw new Error("Existing template body unavailable for integrity guard");
  if (!stackSet.AutoDeployment || typeof stackSet.AutoDeployment.Enabled !== "boolean") throw new Error("Explicit auto-deployment configuration required");
  if (Object.keys(stackSet.AutoDeployment).some((key) => !["Enabled", "RetainStacksOnAccountRemoval", "DependsOn"].includes(key))) throw new Error("Unknown auto-deployment fields require review");
  return {
    stackSetId: stackSet.StackSetId,
    stackSetArn: stackSet.StackSetARN,
    capabilities: [...(stackSet.Capabilities ?? [])].sort(),
    autoDeployment: stackSet.AutoDeployment,
    immutableHashes: {
      template: hash(stackSet.TemplateBody), parameters: hash(sorted(stackSet.Parameters ?? [], "ParameterKey")),
      tags: hash(sorted(stackSet.Tags ?? [], "Key")), capabilities: hash([...(stackSet.Capabilities ?? [])].sort()),
      instances: hash(sorted(instances.map((i) => ({ Account: i.Account, Region: i.Region, StackId: i.StackId, Status: i.Status, StackInstanceStatus: i.StackInstanceStatus, LastOperationId: i.LastOperationId })), "StackId")),
    },
    instanceCount: instances.length,
  };
}

export function metadataOnlyUpdateArgs(plan) {
  if (plan.account !== ACCOUNT || plan.region !== REGION || !STACK_SETS.has(plan.stackSetName) || !["SELF", "DELEGATED_ADMIN"].includes(plan.callAs)) throw new Error("Unexpected metadata-only target");
  return ["cloudformation", "update-stack-set", "--stack-set-name", plan.stackSetName, "--call-as", plan.callAs,
    // Retention/dependencies are valid only while enabled; disabled requests must omit them.
    "--use-previous-template", "--auto-deployment", JSON.stringify({ Enabled: false }),
    ...(plan.before.capabilities?.length ? ["--capabilities", ...plan.before.capabilities] : []), "--operation-id", randomUUID()];
}

export function assertDisabledAutoDeployment(after, before) {
  if (after.Enabled !== false) throw new Error("Auto-deployment readback mismatch");
  for (const [key, fallback] of [["RetainStacksOnAccountRemoval", false], ["DependsOn", []]]) {
    // AWS may omit inactive properties. When returned, unexpected changes still fail closed.
    if (Object.hasOwn(after, key) && stable(after[key]) !== stable(before[key] ?? fallback)) {
      throw new Error("Inactive auto-deployment option changed unexpectedly");
    }
  }
}

function awsRunner(profile) {
  return (args) => JSON.parse(execFileSync("aws", [...args, "--profile", profile, "--region", REGION, "--output", "json", "--no-cli-pager"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}
function readCurrent(aws, callAs, stackSetName) {
  const response = aws(["cloudformation", "describe-stack-set", "--stack-set-name", stackSetName, "--call-as", callAs]);
  const instances = aws(["cloudformation", "list-stack-instances", "--stack-set-name", stackSetName, "--call-as", callAs]).Summaries ?? [];
  const operations = aws(["cloudformation", "list-stack-set-operations", "--stack-set-name", stackSetName, "--call-as", callAs]).Summaries ?? [];
  if (operations.some((op) => ["RUNNING", "QUEUED", "STOPPING"].includes(op.Status))) throw new Error("StackSet operation active; stop before metadata change");
  return snapshotStackSet(response.StackSet, instances, stackSetName);
}
function verifyIdentity(aws) {
  const identity = aws(["sts", "get-caller-identity"]);
  if (identity.Account !== ACCOUNT || !identity.Arn.includes(":assumed-role/GitHubCICDRole/")) throw new Error("Unexpected approved account/role");
}

export async function runMetadataControl({ mode, profile, callAs = "SELF", stackSetName = STACK_SET, planPath, aws = awsRunner(profile), delay = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!STACK_SETS.has(stackSetName)) throw new Error("Unexpected metadata-only StackSet target");
  verifyIdentity(aws);
  if (mode === "plan") {
    if (!["SELF", "DELEGATED_ADMIN"].includes(callAs)) throw new Error("Invalid CallAs");
    const before = readCurrent(aws, callAs, stackSetName);
    const plan = { schema: 1, account: ACCOUNT, region: REGION, stackSetName, callAs, observedAt: new Date().toISOString(), before };
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    return { status: "planned", account: ACCOUNT, region: REGION, stackSetName, instanceCount: before.instanceCount, autoDeployment: before.autoDeployment };
  }
  if (mode !== "apply") throw new Error("Expected plan or apply");
  if (existsSync(`${planPath}.operation.json`)) throw new Error("An operation receipt already exists; reconcile it instead of resubmitting");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (plan.stackSetName !== stackSetName) throw new Error("Plan target does not match explicit StackSet target");
  const args = metadataOnlyUpdateArgs(plan), current = readCurrent(aws, plan.callAs, stackSetName);
  if (stable(current) !== stable(plan.before)) throw new Error("StackSet or instances changed since reviewed plan");
  if (!current.autoDeployment.Enabled) return { status: "already-disabled", instanceCount: current.instanceCount };
  const operation = aws(args);
  if (!operation.OperationId) throw new Error("Missing operation receipt; reconcile before retrying");
  writeFileSync(`${planPath}.operation.json`, JSON.stringify({ operationId: operation.OperationId, submittedAt: new Date().toISOString(), target: stackSetName }, null, 2) + "\n", { flag: "wx" });
  let finished = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const op = aws(["cloudformation", "describe-stack-set-operation", "--stack-set-name", stackSetName, "--call-as", plan.callAs, "--operation-id", operation.OperationId]).StackSetOperation;
    if (op.Status === "SUCCEEDED") { finished = true; break; }
    if (["FAILED", "STOPPED"].includes(op.Status)) throw new Error("Metadata operation failed; reconcile recorded operation before any retry");
    await delay(3000);
  }
  if (!finished) throw new Error("Metadata operation pending; reconcile receipt, do not resubmit");
  const results = aws(["cloudformation", "list-stack-set-operation-results", "--stack-set-name", stackSetName, "--call-as", plan.callAs, "--operation-id", operation.OperationId]).Summaries ?? [];
  if (results.length) throw new Error("Unexpected instance-operation results; investigate before claiming metadata-only success");
  const after = readCurrent(aws, plan.callAs, stackSetName);
  if (stable(after.immutableHashes) !== stable(plan.before.immutableHashes) || after.instanceCount !== plan.before.instanceCount || after.stackSetId !== plan.before.stackSetId) throw new Error("Template, parameters or instances changed; investigate");
  assertDisabledAutoDeployment(after.autoDeployment, plan.before.autoDeployment);
  writeFileSync(`${planPath}.verified.json`, JSON.stringify({ account: ACCOUNT, region: REGION, stackSetName, operationId: operation.OperationId, after, verifiedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  return { status: "disabled-and-verified", operationId: operation.OperationId, instanceCount: after.instanceCount, instanceChanges: 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = new Map();
    for (let i = 2; i < process.argv.length; i += 2) {
      if (!["--mode", "--profile", "--call-as", "--stack-set", "--plan"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i])) throw new Error("Expected --mode plan|apply --profile NAME --plan PATH and optional --call-as/--stack-set");
      args.set(process.argv[i], process.argv[i + 1]);
    }
    if (!args.get("--profile") || !args.get("--plan")) throw new Error("Explicit approved profile and plan path required");
    console.log(JSON.stringify(await runMetadataControl({ mode: args.get("--mode"), profile: args.get("--profile"), callAs: args.get("--call-as") ?? "SELF", stackSetName: args.get("--stack-set") ?? STACK_SET, planPath: args.get("--plan") })));
  } catch (error) { console.error(`Quota auto-enrollment control stopped: ${error.message}`); process.exitCode = 1; }
}
