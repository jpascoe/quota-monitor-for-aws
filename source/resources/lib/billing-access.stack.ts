import { App, CfnOutput, CfnParameter, Stack, StackProps, aws_iam as iam } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";

export class QuotaMonitorBillingAccess extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);
    const hubAccountId = new CfnParameter(this, "HubAccountId", { type: "String", default: "007427784471", description: "Monitoring account that hosts the billing collector" });
    const reader = new iam.Role(this, "BillingReader", {
      roleName: "QuotaMonitorBillingReader",
      assumedBy: new iam.ArnPrincipal(this.formatArn({ service: "iam", region: "", account: hubAccountId.valueAsString, resource: "role", resourceName: "QuotaMonitorBillingCollector" })),
    });
    reader.addToPolicy(new iam.PolicyStatement({ actions: ["ce:GetCostAndUsage", "ce:GetCostForecast", "freetier:GetFreeTierUsage", "billing:GetBillingViewData"], resources: ["*"] }));
    NagSuppressions.addResourceSuppressions(reader, [{ id: "AwsSolutions-IAM5", reason: "Cost Explorer, Free Tier, and Billing View APIs do not support resource-level authorization; the policy is limited to the four read-only collection actions." }], true);
    new CfnOutput(this, "BillingReaderRoleArn", { value: reader.roleArn });
  }
}
