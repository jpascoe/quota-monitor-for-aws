#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ORDER_RIDGE_ACCOUNT = "057193910852";
const ELIGIBLE_REGIONS = new Set(["ap-southeast-2", "us-east-1"]);
// These billed services corroborate the current OrderRidge API and Cognito-mail workload.
// Monitoring infrastructure charges alone cannot satisfy the workload evidence gate.
const WORKLOAD_BILLING_SERVICES = new Set(["Amazon API Gateway", "Amazon Simple Email Service"]);

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function verifyOrderRidgeMonitoringScope(policy, { account, region }) {
  if (account !== ORDER_RIDGE_ACCOUNT) throw new Error("Unexpected OrderRidge account");
  if (!ELIGIBLE_REGIONS.has(region)) throw new Error("Region is not eligible for OrderRidge monitoring");
  const review = policy.orderRidgeReview;
  if (
    !review || review.billingEvidenceRequired !== true ||
    !Array.isArray(review.eligibleRegions) || review.eligibleRegions.length !== 2 ||
    new Set(review.eligibleRegions).size !== 2 ||
    !review.eligibleRegions.every((entry) => ELIGIBLE_REGIONS.has(entry))
  ) throw new Error("Explicit eligible-region and billing-evidence policy is required");
  const scopes = policy.quotaScopes?.filter((scope) => scope.account === account && scope.region === region);
  if (!scopes || scopes.length !== 1 || scopes[0].enabled !== true) throw new Error("Region is not explicitly enabled in reviewed scope");
  const scope = scopes[0];
  if (
    !Array.isArray(scope.allowedServices) || !scope.allowedServices.length ||
    new Set(scope.allowedServices).size !== scope.allowedServices.length ||
    !scope.allowedServices.every((service) => typeof service === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(service))
  ) throw new Error("Reviewed service allowlist is required");
  if (review.pollingFrequency !== "rate(7 days)" || review.newServicesOptIn !== true || review.pollerPolicyRequired !== true) {
    throw new Error("Weekly polling, new-service opt-in and required poller policy must be preserved");
  }
  const proof = review.regionalBillingEvidence?.[region];
  if (!proof || proof.account !== account || proof.region !== region) throw new Error("Matching regional billing evidence is required");
  if (proof.source !== "AWS Cost Explorer" || proof.monitorOnly !== false) throw new Error("Reviewed workload billing evidence is required");
  if (
    !validDate(proof.observedAt) || !validDate(proof.period?.start) || !validDate(proof.period?.endExclusive) ||
    proof.period.start >= proof.period.endExclusive || proof.period.endExclusive > proof.observedAt
  ) throw new Error("Billing evidence needs a valid observed date and bounded historical period");
  if (!Array.isArray(proof.excludedRecordTypes) || !["Credit", "Refund"].every((type) => proof.excludedRecordTypes.includes(type))) {
    throw new Error("Billing evidence must exclude credits and refunds");
  }
  const qualifying = proof.workloadServices?.filter((entry) =>
    WORKLOAD_BILLING_SERVICES.has(entry.service) &&
    typeof entry.amountUsd === "string" && /^\d+(?:\.\d+)?$/.test(entry.amountUsd) && Number.isFinite(Number(entry.amountUsd)) && Number(entry.amountUsd) > 0 &&
    typeof entry.workloadEvidence === "string" && entry.workloadEvidence.trim().length > 0
  );
  if (!qualifying?.length) throw new Error("Positive reviewed application billing is required; monitor-only charges are insufficient");
  return { account, region, pollingFrequency: review.pollingFrequency, allowedServices: scope.allowedServices, billingEvidenceObservedAt: proof.observedAt };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = process.argv[index];
      const value = process.argv[index + 1];
      if (!["--account", "--region", "--policy"].includes(name) || !value || args.has(name)) throw new Error("Expected --account, --region and optional --policy");
      args.set(name, value);
    }
    const path = args.get("--policy") ?? fileURLToPath(new URL("../monitoring-scope-policy.json", import.meta.url));
    const policy = JSON.parse(readFileSync(path, "utf8"));
    const result = verifyOrderRidgeMonitoringScope(policy, { account: args.get("--account"), region: args.get("--region") });
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error) {
    console.error(`OrderRidge monitoring activation blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
