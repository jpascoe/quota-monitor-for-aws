# Organisation quota monitoring controls — IC-96

13 November 2026. Apply the reviewed OrderRidge rules to every accessible account; retain access gaps explicitly. This is not authority to replace application infrastructure, enable an unbilled region or deploy the whole organisation hub.

## Activation policy

Only `ap-southeast-2` and `us-east-1` are eligible. Before enabling a quota scope, record positive workload billing in that exact account and region plus current same-region application-resource corroboration. Quota-monitor resources and their own request/storage charges alone do not qualify. Necessary services can be individually free-tiered once the region qualifies. Preserve existing application alarms, security controls, subscriptions, budget routes and deliberately paused application workflows.

`scripts/verify-monitoring-scope.mjs` is an offline activation gate. It reads `monitoring-scope-policy.json` (or explicit `--policy`) and requires:

- One explicitly enabled `quotaScopes` record for the exact account/region, with a nonempty unique service allowlist.
- `organisationReview` requiring weekly polling, new-service opt-in, required runtime policy and exactly the two eligible regions.
- `organisationReview.regionalBillingEvidence["<account>:<region>"]` with source `AWS Cost Explorer`, matching account/region, observed date, bounded historical period, credit/refund exclusions and `monitorOnly=false`.
- Positive decimal-string `workloadServices[].amountUsd`, a reviewed workload explanation and at least one matching `resources[]` entry (`region`, optional matching `account`, `kind`, `identifier`, `monitoringResource=false`). Quota-monitor names are rejected even if incorrectly labelled as application resources.

Run `node scripts/verify-monitoring-scope.mjs --account <account> --region <region> --policy <reviewed-policy.json>` before activation. Missing, mismatched, zero, monitor-only or resource-uncorroborated proof fails closed. The existing OrderRidge-specific validator remains compatible with its established policy/evidence. These commands query no AWS billing API and enroll nothing.

The poller must have `QUOTA_SCOPE_POLICY_REQUIRED=true`, the exact JSON `MONITORED_SERVICE_ALLOWLIST` and `POLLER_FREQUENCY=rate(7 days)`. Scoped runtime uses exact GetItem reads; missing/malformed policy fails closed and historical unknown keys cannot expand metric requests. Keep discovery new-service default false. Full weekly lookback is 168 hours with existing metric pagination. Replace the exact monitor service-table Scan permission with GetItem only after reviewed policy validation; preserve trust, quota-index Query, event routing and other grants.

## Prevent unreviewed account enrollment

CloudFormation automatic deployment ignores account-level targeting filters, and per-account parameter overrides do not transfer to newly added accounts. New accounts otherwise receive the StackSet defaults. Source SQ, TA and SNS StackSet automatic deployment is therefore disabled, and new hub `RegionsList` defaults explicitly to `us-east-1,ap-southeast-2`; existing explicit parameter values are not silently rewritten.

The official metadata-only command is `aws cloudformation update-stack-set --stack-set-name QM-SQ-Spoke-StackSet --use-previous-template --auto-deployment Enabled=false`, with the verified profile and correct `CallAs`. AWS documents this separately from template/instance updates: [automatic-deployment guide](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-manage-auto-deployment.html). The [UpdateStackSet API](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_UpdateStackSet.html) forbids combining AutoDeployment with DeploymentTargets or Regions.

`scripts/disable-quota-auto-enrollment.mjs` prepares and applies only this control-plane setting for exact owner817495191110 / us-east-1 and the explicit whitelist `QM-SQ-Spoke-StackSet`, `QM-TA-Spoke-StackSet`, `QM-SNS-Spoke-StackSet`. Select one through `--stack-set`; the backwards-compatible default is SQ. Plan mode saves only redacted integrity hashes and configuration, using a fresh account/role check. Apply mode requires unchanged template/parameter/tag/capability/instance hashes and no active operations. It sends no template, parameters, tags, accounts, regions or deployment targets. The AutoDeployment request is exactly `{Enabled:false}`, omitting retention and dependency properties as in the official disable example. AWS rejected the earlier retention-bearing request before creating an operation; do not repeat that request. Existing capabilities are preserved; inactive optional properties are compared when returned and accepted when omitted. The utility journals the returned operation, refuses resubmission, waits for success and requires zero instance-operation results plus unchanged integrity hashes before attesting success.

Plan: `node scripts/disable-quota-auto-enrollment.mjs --mode plan --profile AWSORG-CICD-ROLE --call-as SELF --plan <new-private-plan.json>`.

Only after reviewing that concrete plan: `node scripts/disable-quota-auto-enrollment.mjs --mode apply --profile AWSORG-CICD-ROLE --plan <same-private-plan.json>`. Its saved CallAs governs apply. Stop on unexpected operations/changes; reconcile recorded operation rather than retrying blindly.

Verified control-plane result on 13 November: after the initial retention-bearing request was rejected before any operation, a fresh plan matched all original integrity hashes and 24 instance records. The corrected Enabled=false-only operation `2ef2e583-8e7d-4461-a2b9-33da1a8a06cd` succeeded. Readback confirms automatic enrollment disabled, zero instance-operation results and unchanged template, parameter, tag, capability and instance hashes. This did not deploy templates or update existing spoke instances. Detailed before/operation/readback receipts remain in ignored private evidence.

Unused TA and SNS StackSets were independently planned and verified with zero existing instances. Their Enabled=false-only operations `397b6f1c-db1b-4178-99d5-b886d24aaaac` (TA) and `f3bb489f-a216-489a-9deb-6fae63e3753c` (SNS) succeeded with zero instance-operation results and unchanged integrity hashes. No new resources were created and existing alert routing was not changed. SQ was not resubmitted.

Do **not** invoke `orgHub:deploy` as a shortcut: it changes asset-bucket encryption, publishes assets and can deploy unrelated infrastructure. Do not change `/QuotaMonitor/RegionsToDeploy`, account or OU parameters during scoped remediation. The deployment manager listens to these Parameter Store changes and can create or delete StackSet instances; reducing its region list is not a harmless scheduler update. Source now also disables the SSM-change enrollment rule, preserving its pattern/target. Disabling StackSet automatic deployment alone does not disable that separate explicit reconciliation path. Live control of the exact watcher must be reviewed and verified separately from the StackSet setting; neither changes quota alert routing.

## Per-scope reconciliation

Capture code SHA/revision, exact service flags via GetItem, schedule definitions/targets, execution policy and application protection hashes. Pause exact quota schedules and establish quiescence before changing flags: monthly discovery can restore a stale in-memory list. Apply tested artifact entries only, then conditional flag writes, the required runtime policy and scoped IAM. Verify the whole scope before enabling weekly polling. Ineligible/unused scopes stay disabled and need no IAM amendment. Failure cleanup must disable only the failed scope, leaving other verified accounts active. Keep IAM/code rollback coordinated and private rollback artifacts ignored. No live synthetic alert or email is needed to verify configuration preservation.
