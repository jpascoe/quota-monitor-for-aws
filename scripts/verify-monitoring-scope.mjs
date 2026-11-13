#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ELIGIBLE_MONITORING_REGIONS = Object.freeze(["ap-southeast-2", "us-east-1"]);
const eligible = new Set(ELIGIBLE_MONITORING_REGIONS);
const monitorName = /(?:stackset-qm|quota[-_ ]?monitor|^qm[-_])/i;
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function corroborates(entry, account, region) {
  if (!entry || typeof entry !== "object") return false;
  const arn = typeof entry.identifier === "string" && entry.identifier.startsWith("arn:") ? entry.identifier.split(":") : undefined;
  if (arn && ((arn[3] && arn[3] !== region) || (arn[4] && arn[4] !== account))) return false;
  return entry.monitoringResource === false && entry.region === region &&
    (entry.account === undefined || entry.account === account) &&
    typeof entry.kind === "string" && entry.kind.trim().length > 0 &&
    typeof entry.identifier === "string" && entry.identifier.trim().length > 0 &&
    !monitorName.test(entry.kind) && !monitorName.test(entry.identifier);
}

/** Offline activation gate: reviewed billing and inventory, never automatic enrollment. */
export function verifyMonitoringScope(policy, { account, region, now = new Date() }) {
  if (typeof account !== "string" || !/^\d{12}$/.test(account)) throw new Error("Exact AWS account is required");
  if (!eligible.has(region)) throw new Error("Region is not eligible for monitoring");
  const review = policy.organisationReview;
  if (!review || review.billingEvidenceRequired !== true ||
      !Array.isArray(review.eligibleRegions) || review.eligibleRegions.length !== 2 ||
      new Set(review.eligibleRegions).size !== 2 || !review.eligibleRegions.every((r) => eligible.has(r))) {
    throw new Error("Explicit eligible-region and billing-evidence policy is required");
  }
  if (review.pollingFrequency !== "rate(7 days)" || review.newServicesOptIn !== true || review.pollerPolicyRequired !== true) {
    throw new Error("Weekly polling, new-service opt-in and required poller policy must be preserved");
  }
  const scopes = policy.quotaScopes?.filter((scope) => scope.account === account && scope.region === region);
  if (!scopes || scopes.length !== 1 || scopes[0].enabled !== true) throw new Error("Region is not explicitly enabled in reviewed scope");
  const scope = scopes[0];
  if (!Array.isArray(scope.allowedServices) || !scope.allowedServices.length ||
      new Set(scope.allowedServices).size !== scope.allowedServices.length ||
      !scope.allowedServices.every((service) => typeof service === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(service))) {
    throw new Error("Reviewed service allowlist is required");
  }
  const proof = review.regionalBillingEvidence?.[`${account}:${region}`];
  if (!proof || proof.account !== account || proof.region !== region) throw new Error("Matching regional billing evidence is required");
  if (proof.source !== "AWS Cost Explorer" || proof.monitorOnly !== false) throw new Error("Reviewed workload billing evidence is required");
  const today = now.toISOString().slice(0, 10);
  if (!validDate(proof.observedAt) || !validDate(proof.period?.start) || !validDate(proof.period?.endExclusive) ||
      proof.period.start >= proof.period.endExclusive || proof.period.endExclusive > proof.observedAt || proof.observedAt > today) {
    throw new Error("Billing evidence needs valid observed dates and a bounded historical period");
  }
  if (!Array.isArray(proof.excludedRecordTypes) || !["Credit", "Refund"].every((type) => proof.excludedRecordTypes.includes(type))) {
    throw new Error("Billing evidence must exclude credits and refunds");
  }
  const qualifying = Array.isArray(proof.workloadServices) && proof.workloadServices.filter((entry) =>
    entry && typeof entry === "object" &&
    typeof entry.service === "string" && entry.service.trim().length > 0 &&
    typeof entry.amountUsd === "string" && /^\d+(?:\.\d+)?$/.test(entry.amountUsd) &&
    Number.isFinite(Number(entry.amountUsd)) && Number(entry.amountUsd) > 0 &&
    typeof entry.workloadEvidence === "string" && entry.workloadEvidence.trim().length > 0 &&
    Array.isArray(entry.resources) && entry.resources.some((resource) => corroborates(resource, account, region))
  );
  if (!qualifying?.length) throw new Error("Positive application billing with same-region non-monitor resource corroboration is required");
  return { account, region, pollingFrequency: review.pollingFrequency, allowedServices: scope.allowedServices, billingEvidenceObservedAt: proof.observedAt };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = process.argv[index], value = process.argv[index + 1];
      if (!["--account", "--region", "--policy"].includes(name) || !value || args.has(name)) throw new Error("Expected --account, --region and optional --policy");
      args.set(name, value);
    }
    const path = args.get("--policy") ?? fileURLToPath(new URL("../monitoring-scope-policy.json", import.meta.url));
    console.log(JSON.stringify({ status: "verified", ...verifyMonitoringScope(JSON.parse(readFileSync(path, "utf8")), { account: args.get("--account"), region: args.get("--region") }) }));
  } catch (error) {
    console.error(`Monitoring activation blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
