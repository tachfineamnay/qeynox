// Offline policy bundle only. No S3/admin client, credentials, apply, bucket creation or mutation.
const bucket = process.env.QEYNOX_ARTIFACT_BUCKET;
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '')) {
  console.error('STORAGE_POLICY_BLOCKED: QEYNOX_ARTIFACT_BUCKET must name the existing reviewed private bucket');
  process.exit(1);
}
const arn = 'arn:aws:s3:::' + bucket;
console.log(JSON.stringify({
  notice: 'Desired policy bundle, not a direct API payload. Review/merge existing policies in place. No public Allow, no version/lifecycle deletion permission. Never apply blindly.',
  applicationIdentityPolicy: { Version: '2012-10-17', Statement: [
    { Sid: 'ListOnlyWorkspaceNamespace', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [arn], Condition: { StringLike: { 's3:prefix': ['workspaces/', 'workspaces/*'] } } },
    { Sid: 'WorkspaceObjectsOnly', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [arn + '/workspaces/*'] },
    { Sid: 'NoVersionPurge', Effect: 'Deny', Action: ['s3:DeleteObjectVersion'], Resource: [arn + '/*'] },
    { Sid: 'NoBucketAdministration', Effect: 'Deny', Action: ['s3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:PutBucketAcl', 's3:PutLifecycleConfiguration', 's3:PutBucketVersioning'], Resource: [arn] },
  ] },
  bucketGuardPolicy: { Version: '2012-10-17', Statement: [
    { Sid: 'RequireExistingSSES3Contract', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: arn + '/*', Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'AES256' } } },
    { Sid: 'NoPublicObjectAcl', Effect: 'Deny', Principal: '*', Action: ['s3:PutObject', 's3:PutObjectAcl'], Resource: arn + '/*', Condition: { StringEquals: { 's3:x-amz-acl': ['public-read', 'public-read-write', 'authenticated-read'] } } },
  ] },
  awsPublicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  minioDesiredAnonymousAccess: 'none',
  boundary: 'IAM/policy cannot replace QeyNox workspace authorization: shared app credentials span workspaces. Preserve existing bucket/KMS/object versions. P22 must inspect actual policy support, anonymous denial, conditional PUT, SSE, GET/HEAD/DELETE and version semantics.',
}, null, 2));
