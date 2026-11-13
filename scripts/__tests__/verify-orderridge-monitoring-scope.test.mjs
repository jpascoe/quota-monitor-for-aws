import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyOrderRidgeMonitoringScope } from "../verify-orderridge-monitoring-scope.mjs";

const policy = JSON.parse(readFileSync(new URL("../../monitoring-scope-policy.json", import.meta.url), "utf8"));
const target = { account: "057193910852", region: "us-east-1" };
const copy = () => structuredClone(policy);

test("accepts the reviewed Virginia workload-billing scope without querying AWS", () => {
  const result = verifyOrderRidgeMonitoringScope(policy, target);
  assert.equal(result.pollingFrequency, "rate(7 days)");
  assert.equal(result.allowedServices.length, 13);
});
test("rejects the disabled Sydney region even when it is eligible", () => {
  assert.throws(() => verifyOrderRidgeMonitoringScope(policy, { ...target, region: "ap-southeast-2" }), /not explicitly enabled/);
});
test("rejects another account or a third region", () => {
  assert.throws(() => verifyOrderRidgeMonitoringScope(policy, { ...target, account: "817495191110" }), /Unexpected/);
  assert.throws(() => verifyOrderRidgeMonitoringScope(policy, { ...target, region: "eu-west-1" }), /not eligible/);
});
test("rejects a widened eligible-region policy", () => {
  const changed = copy(); changed.orderRidgeReview.eligibleRegions.push("eu-west-1");
  assert.throws(() => verifyOrderRidgeMonitoringScope(changed, target), /eligible-region/);
});
test("rejects absent or mismatched billing evidence", () => {
  for (const type of ["missing", "account", "region"]) {
    const changed = copy();
    const proof = changed.orderRidgeReview.regionalBillingEvidence["us-east-1"];
    if (type === "missing") delete changed.orderRidgeReview.regionalBillingEvidence;
    else proof[type] = "incorrect";
    assert.throws(() => verifyOrderRidgeMonitoringScope(changed, target), /Matching regional billing/);
  }
});
test("rejects zero or monitor-only billing even if infrastructure incurs charges", () => {
  for (const type of ["zero", "monitorOnly", "monitorService"]) {
    const changed = copy();
    const proof = changed.orderRidgeReview.regionalBillingEvidence["us-east-1"];
    if (type === "zero") proof.workloadServices.forEach((entry) => { entry.amountUsd = "0"; });
    if (type === "monitorOnly") proof.monitorOnly = true;
    if (type === "monitorService") proof.workloadServices = [{ service: "AmazonCloudWatch", amountUsd: "10", workloadEvidence: "Quota monitor" }];
    assert.throws(() => verifyOrderRidgeMonitoringScope(changed, target), /workload billing|application billing/);
  }
});
test("rejects unbounded dates, refunds and absent workload corroboration", () => {
  for (const type of ["date", "refund", "corroboration"]) {
    const changed = copy();
    const proof = changed.orderRidgeReview.regionalBillingEvidence["us-east-1"];
    if (type === "date") proof.period.endExclusive = "2026-12-01";
    if (type === "refund") proof.excludedRecordTypes = [];
    if (type === "corroboration") proof.workloadServices.forEach((entry) => { delete entry.workloadEvidence; });
    assert.throws(() => verifyOrderRidgeMonitoringScope(changed, target), /bounded|credits|application billing/);
  }
});
test("rejects disabled weekly, opt-in or required-policy controls", () => {
  for (const key of ["pollingFrequency", "newServicesOptIn", "pollerPolicyRequired", "billingEvidenceRequired"]) {
    const changed = copy(); changed.orderRidgeReview[key] = false;
    assert.throws(() => verifyOrderRidgeMonitoringScope(changed, target), /required|preserved/);
  }
});
