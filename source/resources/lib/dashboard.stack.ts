import { App, CfnJson, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, StackProps, aws_cognito as cognito, aws_dynamodb as dynamodb, aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy } from "aws-cdk-lib";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";

export class QuotaMonitorDashboard extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);
    // These values were previously deployed through SSM parameter references.
    // Explicit, non-secret parameters keep dashboard updates independent of the
    // retired SSM entries while preserving the existing hub table and KMS key.
    const quotaTableName = new CfnParameter(this, "QuotaSummaryTable", { type: "String", default: "quota-monitor-hub-QMTable336670B0-1WRCX64RWUY6J", description: "Existing hub quota summary DynamoDB table" });
    const quotaTableKeyArn = new CfnParameter(this, "QuotaSummaryKeyArn", { type: "String", default: "arn:aws:kms:us-east-1:007427784471:key/c7abab06-2124-45d7-9da2-b12b18fb8621", description: "KMS key used by the hub quota summary table" });
    const allowedOrigin = new CfnParameter(this, "AllowedOrigin", { type: "String", default: "*", description: "Dashboard origin; replace * with the Cloudflare URL for production" });
    const originBucket = new CfnParameter(this, "DashboardOriginBucketName", { type: "String", default: "quota-monitor.invisiblesystems.xyz", description: "Existing public S3 website bucket used as the Cloudflare origin" });
    const readerRoleArn = new CfnParameter(this, "BillingReaderRoleArn", { type: "String", default: "arn:aws:iam::817495191110:role/QuotaMonitorBillingReader", description: "Management account role assumed by the billing collector" });
    const billingViewArn = new CfnParameter(this, "BillingViewArn", { type: "String", default: "arn:aws:billing::817495191110:billingview/primary", description: "Consolidated billing view used by the collector" });
    const initialAdmin = new CfnParameter(this, "InitialBillingAdminUsername", { type: "String", noEcho: true, description: "Existing Cognito username added to BillingAdmins" });

    const site = new s3.Bucket(this, "DashboardSite", { websiteIndexDocument: "index.html", websiteErrorDocument: "index.html", blockPublicAccess: new s3.BlockPublicAccess({ blockPublicAcls: false, blockPublicPolicy: false, ignorePublicAcls: false, restrictPublicBuckets: false }), removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false });
    site.addToResourcePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [site.arnForObjects("*")], principals: [new iam.AnyPrincipal()] }));
    const publicOrigin = s3.Bucket.fromBucketName(this, "DashboardOriginSite", originBucket.valueAsString);

    const userPool = new cognito.UserPool(this, "DashboardUsers", { selfSignUpEnabled: false, signInAliases: { email: true }, passwordPolicy: { minLength: 14, requireUppercase: true, requireLowercase: true, requireDigits: true, requireSymbols: true } });
    const client = userPool.addClient("DashboardClient", { authFlows: { userSrp: true, userPassword: true } });
    const identityPool = new cognito.CfnIdentityPool(this, "DashboardIdentityPool", { allowUnauthenticatedIdentities: false, cognitoIdentityProviders: [{ clientId: client.userPoolClientId, providerName: userPool.userPoolProviderName }] });
    const trustConditions = { "StringEquals": { "cognito-identity.amazonaws.com:aud": identityPool.ref }, "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" } };
    const quotaUserRole = new iam.Role(this, "DashboardAuthenticatedRole", { assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", trustConditions, "sts:AssumeRoleWithWebIdentity") });
    const billingAdminRole = new iam.Role(this, "BillingAdminRole", { assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", trustConditions, "sts:AssumeRoleWithWebIdentity") });
    const billingGroup = new cognito.CfnUserPoolGroup(this, "BillingAdmins", { groupName: "BillingAdmins", userPoolId: userPool.userPoolId, roleArn: billingAdminRole.roleArn, precedence: 1 });
    const initialMembership = new cognito.CfnUserPoolUserToGroupAttachment(this, "InitialBillingAdminMembership", {
      groupName: "BillingAdmins",
      username: initialAdmin.valueAsString,
      userPoolId: userPool.userPoolId,
    });
    initialMembership.addDependency(billingGroup);

    const quotaApiRole = new iam.Role(this, "DashboardApiRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")] });
    quotaApiRole.addToPolicy(new iam.PolicyStatement({ actions: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"], resources: [dynamodb.Table.fromTableName(this, "QuotaTable", quotaTableName.valueAsString).tableArn] }));
    quotaApiRole.addToPolicy(new iam.PolicyStatement({ actions: ["kms:Decrypt"], resources: [quotaTableKeyArn.valueAsString] }));
    const quotaApi = new lambda.Function(this, "DashboardApi", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/services/dashboardApi/dist")), role: quotaApiRole, timeout: Duration.seconds(30), logRetention: logs.RetentionDays.ONE_MONTH, environment: { QUOTA_TABLE: quotaTableName.valueAsString } });
    const quotaUrl = quotaApi.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, cors: { allowedOrigins: [allowedOrigin.valueAsString], allowedMethods: [lambda.HttpMethod.GET], allowedHeaders: ["authorization", "content-type", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"] } });

    const billingTable = new dynamodb.Table(this, "BillingSnapshotTable", { partitionKey: { name: "SnapshotDate", type: dynamodb.AttributeType.STRING }, sortKey: { name: "RecordKey", type: dynamodb.AttributeType.STRING }, billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: "ExpiresAt", pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, removalPolicy: RemovalPolicy.RETAIN, encryption: dynamodb.TableEncryption.AWS_MANAGED });
    const collectorRole = new iam.Role(this, "BillingCollectorRole", { roleName: "QuotaMonitorBillingCollector", assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")] });
    collectorRole.addToPolicy(new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: [readerRoleArn.valueAsString] }));
    billingTable.grantReadWriteData(collectorRole);
    const collector = new lambda.Function(this, "BillingCollector", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/services/billingCollector/dist")), role: collectorRole, timeout: Duration.minutes(10), memorySize: 512, logRetention: logs.RetentionDays.ONE_MONTH, environment: { BILLING_TABLE: billingTable.tableName, BILLING_READER_ROLE_ARN: readerRoleArn.valueAsString, BILLING_VIEW_ARN: billingViewArn.valueAsString } });
    new events.Rule(this, "BillingCollectorSchedule", { schedule: events.Schedule.cron({ minute: "0", hour: "6" }), targets: [new targets.LambdaFunction(collector)] });

    const billingApiRole = new iam.Role(this, "BillingApiRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")] });
    billingTable.grantReadData(billingApiRole);
    const billingApi = new lambda.Function(this, "BillingApi", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/services/billingApi/dist")), role: billingApiRole, timeout: Duration.seconds(30), memorySize: 256, logRetention: logs.RetentionDays.ONE_MONTH, environment: { BILLING_TABLE: billingTable.tableName } });
    const billingUrl = billingApi.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, cors: { allowedOrigins: [allowedOrigin.valueAsString], allowedMethods: [lambda.HttpMethod.GET], allowedHeaders: ["authorization", "content-type", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"] } });

    const grantUrl = (role: iam.Role, fn: lambda.Function) => {
      role.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunctionUrl"], resources: [fn.functionArn] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [fn.functionArn], conditions: { Bool: { "lambda:InvokedViaFunctionUrl": "true" } } }));
    };
    grantUrl(quotaUserRole, quotaApi);
    grantUrl(billingAdminRole, quotaApi);
    grantUrl(billingAdminRole, billingApi);
    const roleMappings = new CfnJson(this, "DashboardRoleMappings", { value: { [`${userPool.userPoolProviderName}:${client.userPoolClientId}`]: { Type: "Token", AmbiguousRoleResolution: "AuthenticatedRole" } } });
    new cognito.CfnIdentityPoolRoleAttachment(this, "DashboardIdentityPoolRoles", { identityPoolId: identityPool.ref, roles: { authenticated: quotaUserRole.roleArn }, roleMappings: roleMappings.value as any });
    new s3deploy.BucketDeployment(this, "DashboardAssets", { sources: [s3deploy.Source.asset(path.join(__dirname, "../../../frontend/dist"))], destinationBucket: publicOrigin });

    new CfnOutput(this, "DashboardSiteUrl", { value: site.bucketWebsiteUrl });
    new CfnOutput(this, "DashboardApiUrl", { value: quotaUrl.url });
    new CfnOutput(this, "BillingApiUrl", { value: billingUrl.url });
    new CfnOutput(this, "BillingCollectorRoleArn", { value: collectorRole.roleArn });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    NagSuppressions.addResourceSuppressions(site, [{ id: "AwsSolutions-S1", reason: "Static public website bucket is fronted by Cloudflare." }, { id: "AwsSolutions-S2", reason: "Public reads are intentional for static assets." }, { id: "AwsSolutions-S5", reason: "Cloudflare proxies the S3 website origin." }, { id: "AwsSolutions-S10", reason: "TLS terminates at Cloudflare." }], true);
    NagSuppressions.addResourceSuppressions(userPool, [{ id: "AwsSolutions-COG8", reason: "Cognito Plus tier is optional; strong passwords are in place." }, { id: "AwsSolutions-COG2", reason: "MFA is organization policy and can be enabled separately." }]);
    NagSuppressions.addStackSuppressions(this, [{ id: "AwsSolutions-IAM4", reason: "AWS managed Lambda logging policy is minimal." }, { id: "AwsSolutions-IAM5", reason: "CDK BucketDeployment requires object wildcard permissions." }, { id: "AwsSolutions-L1", reason: "CDK BucketDeployment provider runtime is CDK controlled." }, { id: "AwsSolutions-DDB3", reason: "PITR and TTL protect daily billing snapshots." }]);
  }
}
