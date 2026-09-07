import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { QuotaMonitorBillingAccess } from "../lib/billing-access.stack";
import { QuotaMonitorDashboard } from "../lib/dashboard.stack";

describe("billing dashboard resources", () => {
  it("creates retained billing snapshots, collection, and separate billing access", () => {
    const template = Template.fromStack(new QuotaMonitorDashboard(new App(), "DashboardTest"));
    template.hasResourceProperties("AWS::DynamoDB::Table", { TimeToLiveSpecification: { AttributeName: "ExpiresAt", Enabled: true }, BillingMode: "PAY_PER_REQUEST" });
    template.resourceCountIs("AWS::Lambda::Url", 2);
    template.hasResourceProperties("AWS::Cognito::UserPoolGroup", { GroupName: "BillingAdmins" });
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "cron(0 6 * * ? *)" });
  });

  it("limits management billing access to the hub collector role", () => {
    const template = Template.fromStack(new QuotaMonitorBillingAccess(new App(), "BillingAccessTest"));
    template.hasResourceProperties("AWS::IAM::Role", { RoleName: "QuotaMonitorBillingReader" });
  });
});
