# OrderRidge quota monitoring — 13 November 2026

Delivery record: [IC-96](https://grexp.atlassian.net/browse/IC-96). Account: `057193910852`. This project is the quota-monitor source checkout, not the Terraform Starter Kit. No Terraform operation is involved.

## Reviewed target

Keep weekly Service Quotas polling (`rate(7 days)`) in Northern Virginia (`us-east-1`) for `acm`, `apigateway`, `cloudfront`, `cognito-idp`, `dynamodb`, `events`, `kms`, `lambda`, `route53`, `s3`, `ses`, `sns` and `wafv2`. Every code exists in the account's currently enumerated Virginia service table. These support the observed application, authentication, storage, notification, encryption and global-edge dependencies. Services without quota-utilisation metrics do not manufacture paid metric reads.

Disable both quota-poller and monthly-discovery schedules in Sydney (`ap-southeast-2`), with all its service flags disabled. The live inventory found no Sydney application Lambdas, data tables, APIs, user pools or topics; its quota-monitor infrastructure is not a reason to retain full application monitoring there. Retain monthly discovery in the active Virginia scope so new services remain visible but disabled until explicitly selected.

The before-state contained 320 enabled Virginia services and 258 enabled Sydney services. Both polling rules were already disabled when inspected, despite their configured 12-hour frequency. Establish their audit-trail intent before enabling Virginia's reviewed weekly rule; never label this a simple reduction from an actively running 12-hour rule. Paused receiving/cleanup schedules remain paused.

## Source controls

- New-service discovery defaults `Monitored` to `false`, preserving existing enabled/disabled choices. Explicit SageMaker/Connect selections remain supported.
- New hub and Service Quotas spoke defaults use weekly polling and `No` for SageMaker/Connect. Existing stacks must retain previous explicit parameter values unless the reviewed scope specifically changes them.
- The poller recognises weekly frequency as 168 hours. Updating only EventBridge would otherwise query 24 hours per weekly run and leave gaps in quota telemetry.
- OrderRidge pollers require an explicit JSON `MONITORED_SERVICE_ALLOWLIST` and `QUOTA_SCOPE_POLICY_REQUIRED=true`. Virginia's policy is its 13 reviewed service codes; Sydney's is `[]`. Set equivalent optional spoke parameters `MonitoredServiceAllowlist` and `QuotaScopePolicyRequired` when a future scoped CloudFormation update is reviewed. Defaults remain empty/false for legacy accounts, preserving their behaviour.
- Scoped polling reads only the approved complete `ServiceCode` keys with `GetItem`, selecting only items whose `Monitored` value is exactly `true`. It never invokes legacy service-table scanning. Missing/malformed required policy fails before DynamoDB, quota or metric reads. This prevents an unknown historical service item from expanding metric polling, even when inventory enumeration cannot prove every historical key absent.
- The poller needs `dynamodb:GetItem` only on its exact service-table ARN for this path. Verify that permission before activation. Source adds this narrowly scoped read action and removes `Scan` when `QuotaScopePolicyRequired=true`. The false legacy setting retains its prior scan permission, while OrderRidge's required scoped path has no service-table scan permission. Do not broaden table resources or grant scan permissions to reconcile this account.
- Preserve existing thresholds, notification/event routes and runtime. Retain native operational error, throttle, queue-backlog, authentication and spending controls. Do not change WAF, application code, credentials or intentionally paused schedules.

## Verification and rollback

Before mutation, verify the assumed account, exact tables, Lambda code hashes/revision IDs and exact schedules. Preserve their metadata and original artifact bytes privately. Apply only the reviewed account/region/service changes, opt-in discovery and weekly lookback correction. Review the narrow change plan; do not publish/deploy the whole hub or modify other accounts.

Use exact-key service-table reads to verify the 13 retained flags and known exclusions; do not scan application or monitoring tables or claim enumeration proves every historical item absent. The required runtime allowlist enforces the bound independently. Verify expected schedule state/frequency and Lambda read-back. Compare operational alarm definitions, app schedules, WAF association, budgets and notification configuration before/after; do not emit synthetic live alerts to unreviewed recipients. Poller regression tests verify complete 6-, 12-, 24- and 168-hour query intervals, exclusion of enabled unknown/retired services, disabled approved services and missing/malformed required policies. Discovery tests preserve explicit choices; CDK tests verify enrollment defaults and scoped-policy environment wiring.

Rollback only the exact changed service flags, rule definitions and Lambda artifacts/revisions from the saved evidence. Restoring the old artifact restores its shorter metric window and automatic discovery default, so use rollback only to recover a demonstrated failure and retain a follow-up item. Do not restore unrelated historical state or broaden IAM to bypass an access error.

Fresh tests, TypeScript build and CDK synthesis must pass before deployment. Central before/after and verification receipts, source commits and remaining limitations are recorded under IC-96 and its linked Security, Infrastructure and Deployment page. A successful source build is not proof of live alert delivery or realised savings. No new paid monitoring service is required; compare later existing billing without double-counting earlier reductions.

## Source validation

The 13 November source checks passed: 25 poller tests, 32 discovery tests, 35 hub/spoke CDK tests, the poller TypeScript build, eight-stack synthesis and scoped whitespace validation. The synthesized spoke template defaults to weekly polling, wires optional policy parameters to the poller and removes service-table `Scan` when its policy is required. Existing CloudWatch helper pagination consumes every `GetMetricData` page; no helper pagination change is needed. Only the tested poller `index.js` and `exports.js` are needed for the guarded runtime-code correction; source/default changes do not authorise a broad hub rollout.
