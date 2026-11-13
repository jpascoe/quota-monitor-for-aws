import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { snapshotStackSet, metadataOnlyUpdateArgs, assertDisabledAutoDeployment, runMetadataControl } from "../disable-quota-auto-enrollment.mjs";

const account = "817495191110", region = "us-east-1", name = "QM-SQ-Spoke-StackSet";
const stackSet = { StackSetName: name, StackSetId: `${name}:uuid`, StackSetARN: `arn:aws:cloudformation:${region}:${account}:stackset/${name}:uuid`, Status: "ACTIVE", PermissionModel: "SERVICE_MANAGED", AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false }, TemplateBody: '{"Resources":{}}', Parameters: [{ ParameterKey: "SageMakerMonitoring", ParameterValue: "Yes" }], Capabilities: ["CAPABILITY_IAM"], Tags: [] };
const instances = [{ Account: "007427784471", Region: region, StackId: "arn:aws:cloudformation:us-east-1:007427784471:stack/example/id", Status: "CURRENT", LastOperationId: "prior" }];
const plan = () => ({ account, region, stackSetName: name, callAs: "SELF", before: snapshotStackSet(stackSet, instances) });

test("disable request sends only Enabled=false, omitting enabled-only options", () => {
  const args = metadataOnlyUpdateArgs(plan());
  assert.ok(args.includes("--use-previous-template"));
  for (const prohibited of ["--template-body", "--template-url", "--parameters", "--regions", "--deployment-targets", "--accounts", "--tags"]) assert.ok(!args.includes(prohibited));
  assert.deepEqual(JSON.parse(args[args.indexOf("--auto-deployment") + 1]), { Enabled: false });
  const withDependencies = plan();
  withDependencies.before.autoDeployment = { Enabled: true, RetainStacksOnAccountRemoval: true, DependsOn: ["arn:aws:cloudformation:us-east-1:817495191110:stackset/prerequisite:id"] };
  const request = metadataOnlyUpdateArgs(withDependencies);
  assert.deepEqual(JSON.parse(request[request.indexOf("--auto-deployment") + 1]), { Enabled: false });
});
test("disabled readback accepts omitted inactive options but compares returned options", () => {
  const before = { Enabled: true, RetainStacksOnAccountRemoval: false };
  assert.doesNotThrow(() => assertDisabledAutoDeployment({ Enabled: false }, before));
  assert.doesNotThrow(() => assertDisabledAutoDeployment({ Enabled: false, RetainStacksOnAccountRemoval: false }, before));
  assert.throws(() => assertDisabledAutoDeployment({ Enabled: true }, before), /readback/);
  assert.throws(() => assertDisabledAutoDeployment({ Enabled: false, RetainStacksOnAccountRemoval: true }, before), /changed unexpectedly/);
});
test("rejects another owner, StackSet, region or permission model", () => {
  for (const change of [{ StackSetName: "other" }, { PermissionModel: "SELF_MANAGED" }, { StackSetARN: "arn:aws:cloudformation:eu-west-1:123456789012:stackset/other:id" }]) assert.throws(() => snapshotStackSet({ ...stackSet, ...change }, instances), /Unexpected/);
  assert.throws(() => metadataOnlyUpdateArgs({ ...plan(), region: "ap-southeast-2" }), /Unexpected/);
  assert.throws(() => metadataOnlyUpdateArgs({ ...plan(), stackSetName: "unrelated-stackset" }), /Unexpected/);
});
test("snapshot detects changes to old parameters, template and instances", () => {
  const a = snapshotStackSet(stackSet, instances);
  const b = snapshotStackSet({ ...stackSet, Parameters: [] }, instances);
  assert.notEqual(a.immutableHashes.parameters, b.immutableHashes.parameters);
  assert.notEqual(a.immutableHashes.instances, snapshotStackSet(stackSet, []).immutableHashes.instances);
  assert.notEqual(a.immutableHashes.template, snapshotStackSet({ ...stackSet, TemplateBody: "different" }, instances).immutableHashes.template);
});

function fakeAws({ drift = false, operationResults = [], enabled = true, active = false, omitInactive = false, stackSetName = name, empty = false } = {}) {
  let updated = false;
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const operation = args[1];
    if (args[0] === "sts") return { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/GitHubCICDRole/test` };
    if (operation === "describe-stack-set") return { StackSet: { ...stackSet, StackSetName: stackSetName, StackSetId: `${stackSetName}:uuid`, StackSetARN: `arn:aws:cloudformation:${region}:${account}:stackset/${stackSetName}:uuid`, ...(drift ? { TemplateBody: "changed" } : {}), AutoDeployment: updated && omitInactive ? { Enabled: false } : { ...stackSet.AutoDeployment, Enabled: updated ? false : enabled } } };
    if (operation === "list-stack-instances") return { Summaries: empty ? [] : instances };
    if (operation === "list-stack-set-operations") return { Summaries: active ? [{ Status: "RUNNING" }] : [] };
    if (operation === "update-stack-set") { updated = true; return { OperationId: "metadata-only-id" }; }
    if (operation === "describe-stack-set-operation") return { StackSetOperation: { Status: "SUCCEEDED" } };
    if (operation === "list-stack-set-operation-results") return { Summaries: operationResults };
    throw new Error(`Unexpected operation ${operation}`);
  };
  return { fn, calls };
}
async function inTemp(fn) {
  const directory = mkdtempSync(join(tmpdir(), "quota-autodeploy-test-"));
  try { return await fn(join(directory, "plan.json")); } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("quota-autodeploy-test-"));
    rmSync(directory, { recursive: true, force: true });
  }
}
test("mocked plan/apply verifies zero instance operations and preserves hashes", async () => inTemp(async (path) => {
  const f = fakeAws();
  await runMetadataControl({ mode: "plan", profile: "approved", planPath: path, aws: f.fn });
  const result = await runMetadataControl({ mode: "apply", profile: "approved", planPath: path, aws: f.fn });
  assert.equal(result.status, "disabled-and-verified");
  assert.equal(result.instanceChanges, 0);
  assert.equal(JSON.parse(readFileSync(`${path}.verified.json`, "utf8")).after.instanceCount, 1);
}));
test("provider regression: mocked apply succeeds when disabled response omits retention", async () => inTemp(async (path) => {
  const f = fakeAws({ omitInactive: true });
  await runMetadataControl({ mode: "plan", profile: "approved", planPath: path, aws: f.fn });
  assert.equal((await runMetadataControl({ mode: "apply", profile: "approved", planPath: path, aws: f.fn })).status, "disabled-and-verified");
  const update = f.calls.find((args) => args[1] === "update-stack-set");
  assert.deepEqual(JSON.parse(update[update.indexOf("--auto-deployment") + 1]), { Enabled: false });
}));
test("drift and active operations stop before any update", async () => inTemp(async (path) => {
  await runMetadataControl({ mode: "plan", profile: "approved", planPath: path, aws: fakeAws().fn });
  for (const f of [fakeAws({ drift: true }), fakeAws({ active: true })]) {
    await assert.rejects(runMetadataControl({ mode: "apply", profile: "approved", planPath: path, aws: f.fn }), /changed|active/);
    assert.ok(!f.calls.some((args) => args[1] === "update-stack-set"));
  }
}));
test("unexpected instance operation results prevent success attestation", async () => inTemp(async (path) => {
  const f = fakeAws({ operationResults: [{ Account: "007427784471", Status: "SUCCEEDED" }] });
  await runMetadataControl({ mode: "plan", profile: "approved", planPath: path, aws: f.fn });
  await assert.rejects(runMetadataControl({ mode: "apply", profile: "approved", planPath: path, aws: f.fn }), /Unexpected instance-operation/);
}));
test("already-disabled configuration does not submit another operation", async () => inTemp(async (path) => {
  const f = fakeAws({ enabled: false });
  await runMetadataControl({ mode: "plan", profile: "approved", planPath: path, aws: f.fn });
  assert.equal((await runMetadataControl({ mode: "apply", profile: "approved", planPath: path, aws: f.fn })).status, "already-disabled");
  assert.ok(!f.calls.some((args) => args[1] === "update-stack-set"));
}));
test("only the three explicit QM targets are accepted, with no AWS call for an unknown target", async () => inTemp(async (path) => {
  const f = fakeAws();
  await assert.rejects(runMetadataControl({ mode: "plan", profile: "approved", stackSetName: "unrelated-stackset", planPath: path, aws: f.fn }), /Unexpected/);
  assert.equal(f.calls.length, 0);
}));
test("TA and SNS metadata-only updates support zero existing instances", async () => {
  for (const stackSetName of ["QM-TA-Spoke-StackSet", "QM-SNS-Spoke-StackSet"]) await inTemp(async (path) => {
    const f = fakeAws({ stackSetName, empty: true, omitInactive: true });
    await runMetadataControl({ mode: "plan", profile: "approved", stackSetName, planPath: path, aws: f.fn });
    const result = await runMetadataControl({ mode: "apply", profile: "approved", stackSetName, planPath: path, aws: f.fn });
    assert.equal(result.status, "disabled-and-verified");
    assert.equal(result.instanceCount, 0);
    const update = f.calls.find((args) => args[1] === "update-stack-set");
    assert.equal(update[update.indexOf("--stack-set-name") + 1], stackSetName);
    assert.deepEqual(JSON.parse(update[update.indexOf("--auto-deployment") + 1]), { Enabled: false });
  });
});
