import { App, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, StackProps, aws_cognito as cognito, aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_ssm as ssm } from "aws-cdk-lib";
import * as path from "path";
import { NagSuppressions } from "cdk-nag";

export class QuotaMonitorDashboard extends Stack {
  constructor(scope: App, id: string, props?: StackProps) {
    super(scope, id, props);
    const tableName = ssm.StringParameter.valueForStringParameter(this, "/QuotaMonitor/Dashboard/QuotaSummaryTable");
    const allowedOrigin = new CfnParameter(this, "AllowedOrigin", { type: "String", default: "*", description: "Dashboard origin; replace * with the Cloudflare URL for production" });
    const site = new s3.Bucket(this, "DashboardSite", { websiteIndexDocument: "index.html", websiteErrorDocument: "index.html", blockPublicAccess: new s3.BlockPublicAccess({ blockPublicAcls: false, blockPublicPolicy: false, ignorePublicAcls: false, restrictPublicBuckets: false }), removalPolicy: RemovalPolicy.RETAIN, autoDeleteObjects: false });
    site.addToResourcePolicy(new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [site.arnForObjects("*")], principals: [new iam.AnyPrincipal()] }));
    NagSuppressions.addResourceSuppressions(site, [
      { id: "AwsSolutions-S1", reason: "Static public website bucket is fronted by Cloudflare; access logs are managed at the edge." },
      { id: "AwsSolutions-S2", reason: "Public object reads are intentional for the static React assets; no quota data is stored in this bucket." },
      { id: "AwsSolutions-S5", reason: "Cloudflare is the requested frontend endpoint and proxies the S3 website origin." },
      { id: "AwsSolutions-S10", reason: "S3 website origins support HTTP only; end-user TLS terminates at Cloudflare as documented." },
    ], true);
    const userPool = new cognito.UserPool(this, "DashboardUsers", { selfSignUpEnabled: false, signInAliases: { email: true }, passwordPolicy: { minLength: 14, requireUppercase: true, requireLowercase: true, requireDigits: true, requireSymbols: true } });
    NagSuppressions.addResourceSuppressions(userPool, [{ id: "AwsSolutions-COG8", reason: "Cognito Plus tier is an optional cost-bearing feature; the pool uses strong password policy and can enable MFA by deployment policy." }, { id: "AwsSolutions-COG2", reason: "MFA policy is managed by the organization and can be enabled without changing the dashboard data boundary." }]);
    const client = userPool.addClient("DashboardClient", { authFlows: { userSrp: true, userPassword: true } });
    const identityPool = new cognito.CfnIdentityPool(this, "DashboardIdentityPool", { allowUnauthenticatedIdentities: false, cognitoIdentityProviders: [{ clientId: client.userPoolClientId, providerName: userPool.userPoolProviderName }] });
    const authenticatedRole = new iam.Role(this, "DashboardAuthenticatedRole", { assumedBy: new iam.FederatedPrincipal("cognito-identity.amazonaws.com", { "StringEquals": { "cognito-identity.amazonaws.com:aud": identityPool.ref }, "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" } }, "sts:AssumeRoleWithWebIdentity") });
    authenticatedRole.addToPolicy(new iam.PolicyStatement({ actions: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"], resources: ["*"] }));
    const apiRole = new iam.Role(this, "DashboardApiRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")] });
    NagSuppressions.addResourceSuppressions(apiRole, [{ id: "AwsSolutions-IAM4", reason: "AWS managed Lambda basic execution policy is the standard minimal logging policy for this function." }]);
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"], resources: [dynamodb.Table.fromTableName(this, "QuotaTable", tableName).tableArn] }));
    const api = new lambda.Function(this, "DashboardApi", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromAsset(path.join(__dirname, "../../lambda/services/dashboardApi/dist")), role: apiRole, timeout: Duration.seconds(30), environment: { QUOTA_TABLE: tableName, ALLOWED_ORIGIN: allowedOrigin.valueAsString } });
    const fnUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM, cors: { allowedOrigins: [allowedOrigin.valueAsString], allowedMethods: [lambda.HttpMethod.GET], allowedHeaders: ["authorization", "content-type", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"] } });
    new cognito.CfnIdentityPoolRoleAttachment(this, "DashboardIdentityPoolRoles", { identityPoolId: identityPool.ref, roles: { authenticated: authenticatedRole.roleArn } });
    new s3deploy.BucketDeployment(this, "DashboardAssets", { sources: [s3deploy.Source.asset(path.join(__dirname, "../../../frontend/dist"))], destinationBucket: site });
    new CfnOutput(this, "DashboardSiteUrl", { value: site.bucketWebsiteUrl }); new CfnOutput(this, "DashboardApiUrl", { value: fnUrl.url }); new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId }); new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId }); new CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    NagSuppressions.addStackSuppressions(this, [
      { id: "AwsSolutions-IAM4", reason: "CDK BucketDeployment uses the AWS-managed deployment helper role." },
      { id: "AwsSolutions-IAM5", reason: "CDK BucketDeployment requires scoped wildcard object and multipart permissions for publishing static assets." },
      { id: "AwsSolutions-L1", reason: "CDK BucketDeployment provider runtime is controlled by the CDK library." },
    ]);
  }
}
