import test from "node:test";
import assert from "node:assert/strict";
import { verifyMonitoringScope } from "../verify-monitoring-scope.mjs";

const account = "007427784471", region = "ap-southeast-2";
const target = { account, region, now: new Date("2026-11-13T00:00:00Z") };
const policy = {
  quotaScopes: [{ account, region, enabled: true, allowedServices: ["lambda", "s3"] }],
  organisationReview: {
    eligibleRegions: ["ap-southeast-2", "us-east-1"], billingEvidenceRequired: true,
    pollingFrequency: "rate(7 days)", newServicesOptIn: true, pollerPolicyRequired: true,
    regionalBillingEvidence: { [`${account}:${region}`]: {
      account, region, source: "AWS Cost Explorer", observedAt: "2026-11-13",
      period: { start: "2026-10-01", endExclusive: "2026-11-13" }, excludedRecordTypes: ["Credit", "Refund"], monitorOnly: false,
      workloadServices: [{ service: "AWS Lambda", amountUsd: "0.012", workloadEvidence: "Observed application function with regional workload billing", resources: [{ account, region, kind: "LambdaFunction", identifier: "application-handler", monitoringResource: false }] }],
    } },
  },
};
const copy = () => structuredClone(policy);
const proof = (p) => p.organisationReview.regionalBillingEvidence[`${account}:${region}`];

test("accepts reviewed non-OrderRidge account with same-region billing and resources", () => {
  assert.deepEqual(verifyMonitoringScope(policy, target).allowedServices, ["lambda", "s3"]);
});
test("rejects third region, malformed account and disabled or duplicate scopes", () => {
  assert.throws(() => verifyMonitoringScope(policy, { ...target, region: "eu-west-1" }), /not eligible/);
  assert.throws(() => verifyMonitoringScope(policy, { ...target, account: "123" }), /Exact AWS account/);
  for (const type of ["disabled", "duplicate"]) {
    const p = copy(); if (type === "disabled") p.quotaScopes[0].enabled = false; else p.quotaScopes.push(p.quotaScopes[0]);
    assert.throws(() => verifyMonitoringScope(p, target), /not explicitly enabled/);
  }
});
test("rejects missing or mismatched exact account-region proof", () => {
  for (const field of ["missing", "account", "region"]) {
    const p = copy(); if (field === "missing") delete p.organisationReview.regionalBillingEvidence; else proof(p)[field] = "incorrect";
    assert.throws(() => verifyMonitoringScope(p, target), /Matching regional billing/);
  }
});
test("rejects monitor overhead despite positive service charges", () => {
  for (const type of ["monitorOnly", "flag", "name", "kind"]) {
    const p = copy(), pr = proof(p), resource = pr.workloadServices[0].resources[0];
    if (type === "monitorOnly") pr.monitorOnly = true;
    if (type === "flag") resource.monitoringResource = true;
    if (type === "name") resource.identifier = "StackSet-QM-SQ-Spoke-handler";
    if (type === "kind") resource.kind = "Quota Monitor";
    assert.throws(() => verifyMonitoringScope(p, target), /workload billing|resource corroboration/);
  }
});
test("rejects resource in another account or region, or absent inventory corroboration", () => {
  for (const field of ["region", "account", "resources", "workloadEvidence"]) {
    const p = copy(), service = proof(p).workloadServices[0];
    if (["region", "account"].includes(field)) service.resources[0][field] = "incorrect";
    else delete service[field];
    assert.throws(() => verifyMonitoringScope(p, target), /resource corroboration/);
  }
});
test("rejects zero, negative, non-finite and malformed billing amounts", () => {
  for (const amount of ["0", "-1", "Infinity", "NaN", "1e3", "1".repeat(400)]) {
    const p = copy(); proof(p).workloadServices[0].amountUsd = amount;
    assert.throws(() => verifyMonitoringScope(p, target), /Positive application billing/);
  }
});
test("rejects a conflicting resource ARN even if descriptive fields claim the target", () => {
  for (const identifier of ["arn:aws:lambda:us-east-1:007427784471:function:application", "arn:aws:lambda:ap-southeast-2:999999999999:function:application"]) {
    const p = copy(); proof(p).workloadServices[0].resources[0].identifier = identifier;
    assert.throws(() => verifyMonitoringScope(p, target), /resource corroboration/);
  }
});
test("rejects future or unbounded evidence and credits/refunds omission", () => {
  for (const type of ["future", "period", "refund"]) {
    const p = copy(); if (type === "future") proof(p).observedAt = "2027-01-01";
    if (type === "period") proof(p).period.endExclusive = "2026-12-01";
    if (type === "refund") proof(p).excludedRecordTypes = [];
    assert.throws(() => verifyMonitoringScope(p, target), /bounded|credits/);
  }
});
test("rejects relaxed cadence, opt-in, required policy or region boundaries", () => {
  for (const key of ["pollingFrequency", "newServicesOptIn", "pollerPolicyRequired", "billingEvidenceRequired"]) {
    const p = copy(); p.organisationReview[key] = false;
    assert.throws(() => verifyMonitoringScope(p, target), /preserved|required/);
  }
  const p = copy(); p.organisationReview.eligibleRegions.push("us-west-2");
  assert.throws(() => verifyMonitoringScope(p, target), /eligible-region/);
});
